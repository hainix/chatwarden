# Chat filter rules, privacy requests and legal hold (0.2.0) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** an owner can turn on chat filters (links, personal info, phrases, caps and repeats), each with an action (`count`, `flag`,
`mask`, `refuse`) and its own Community Rule, try them on a test line and on recent lines, and read what they did; a `flag` files a
report with no reporter for a person to decide. An owner can export and erase one person's data (with a receipt and a stated safety
remainder), and a senior can hold one report so retention and erase leave it alone, with a signed evidence bundle and a
`report.escalated` event for the game's own process.

**Architecture:**
- `@chatwarden/core` gets `filters.ts` (settings), `filters/` (link scanner, personal-info, phrase and ratio engines, the composed
  engine, counters), a `filters` section in the profile layer, three new refusal reasons, `cw.filters`, `cw.reports.fileSystem`,
  `cw.privacy`, `cw.legal`, `privacy.ts` (the registry and receipts), `canonical.ts` (canonical JSON), two events' worth of vocabulary,
  six audit actions and two permissions.
- `Store` gains required methods (no optional-method shims: the release has no users). Memory and SQLite, three new contract suites.
  One SQLite migration, **26, shared by the whole release**: this plan's DDL is listed below and merged by the controller.
- `@chatwarden/http` adds the filter routes, privacy routes, hold and bundle routes. `@chatwarden/player-react` gets the three
  refusal words. `@chatwarden/hub-react` gets Settings, Advanced, "Chat filters" and "Privacy requests", a queue chip, and two
  `...` items on the Person page and the case.

**Spec:** `docs/design/2026-11-17-filter-rules-and-privacy.md` (section numbers below refer to it), including its Rulings. Also binding:
`docs/design/2026-11-17-moderation-coverage-audit.md` (G1, G2, G5, sections 6 and 7) and the layer conventions of
`docs/design/2026-11-12-flood-control-and-signals.md` (pace) and `docs/design/2026-11-12-appeals-and-names.md`.

## Migration 26 (this plan's part; the controller merges it with the other themes)
Written by F5 and P1 as two labelled blocks of the one migration. Tests assert the schema after the whole migration runs, never the
number alone.
1. `kit_reports`: `ALTER TABLE ... ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('filter', 'watch'))`; `ADD COLUMN origin_key TEXT`;
   `CREATE UNIQUE INDEX kit_reports_open_filter ON kit_reports (target_subject, room_id) WHERE origin = 'filter' AND status = 'open'`;
   `CREATE INDEX kit_reports_by_origin ON kit_reports (origin, created_at) WHERE origin IS NOT NULL`. No rebuild, no row touched.
2. `kit_filter_hits (day INTEGER NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('count','flag','mask','refuse','flag_capped')), hits INTEGER NOT NULL, PRIMARY KEY (day, key, action)) WITHOUT ROWID`.
3. `kit_legal_holds (report_id TEXT PRIMARY KEY, code TEXT NOT NULL CHECK (code IN ('law_enforcement_request','legal_proceeding','platform_request','safety_review','other')), held_by TEXT NOT NULL, held_at INTEGER NOT NULL, released_by TEXT, released_at INTEGER)`; `CREATE INDEX kit_legal_holds_open ON kit_legal_holds (released_at) WHERE released_at IS NULL`.
4. `kit_erasures (id TEXT PRIMARY KEY, at INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('safety','none')), actor TEXT NOT NULL, counts_json TEXT NOT NULL, pending_subject TEXT)`; `CREATE INDEX kit_erasures_pending ON kit_erasures (pending_subject) WHERE pending_subject IS NOT NULL`; plus one row `kit_meta` key `erasure_epoch` (a counter, like the change token).
5. Lookup indexes the erase and hold paths need: `kit_mutes_by_target ON kit_mutes (target_id)`; `kit_blocked_names_by_subject ON kit_blocked_names (subject_id)`; `kit_signals_by_source ON kit_signals (by_subject) WHERE by_subject IS NOT NULL`; `kit_sanctions_by_report ON kit_sanctions (report_id) WHERE report_id IS NOT NULL`.
Nothing else: no existing table is rebuilt by this plan, and an upsert of `kit_subject_ids` becomes conditional on the subject row existing (a statement change, no DDL).

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly`, every time from the injected
  `Clock` (no `Date.now()`), synthetic terms and domains only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn;
  `.example` and `.test` hosts), test-first, targeted runs only, `npm run lint` and `npm run typecheck` before every push. With more than
  one agent in the worktree: commit by pathspec, `git add` new files first.
- **Sequencing.** Part of the single 0.2.0 branch, built in themed chunks. **Step 0, before Task F1:** rebase on the release branch,
  confirm `POLICY_SECTIONS` ends `... 'pace', 'signals', 'appeals', 'names'` plus whatever the other themes appended (append `'filters'`
  last), `AUDIT_ACTIONS` and `KIT_EVENT_TYPES` and `PERMISSION_KEYS` are append-only (append after whatever is last), and read the
  migration-26 block the controller has so far. Tasks marked **after theme X** name what to read. No release-prep task here.
- `@chatwarden/core` stays browser-safe and dependency-free: no `node:` import, no `fetch`, no `URL` constructor, no `Intl.Segmenter`.
  `scripts/browser-bundle.test.ts` is re-checked in F4 and P3; the engine is statically imported unless the budget fails (Ruling 25).
- **Off means identical.** With `filters` unset, every `ChatResult`, event and http body equals what the same code gives without the
  filter module (a parity test in F4 runs the existing chat scripts both ways). With no hold, no export and no erase, no new row is written.
- **No regular expressions from data, no `new RegExp`** in `packages/core/src/filters/`; regex literals only from the reviewed list in
  F2's static test. Every scanner is one forward pass with a step budget (Review Focus 1).
- **A filter never writes a record.** No strike, sanction, timeout or per-person counter; a refused line is not buffered, stored or
  logged. The only per-person effect is a `flag` report that a person decides.
- **Privacy of the work itself:** logs carry event names and error classes only (a spy logger in F4, F5, P2, P3 asserts it); a receipt,
  an event, a webhook body and an audit row hold no line, domain, pattern, hash, key or address.
- **Hub budget.** The first-load budget in `packages/hub-react/test/size.test.ts` is near its limit: the Chat filters panel, the Privacy
  requests panel and both dialogs load on demand; eager code is types, client calls and the queue chip's mapping. `size.test.ts` runs in
  every hub task.
- **UI rule (clean core, power behind one door).** Always visible additions: none, except the neutral queue chip "Filter: ..." on a
  filter report and the quiet "Held for legal" line on a held report (each only when it exists). Everything else sits in Settings,
  Advanced (two lazy panels) and the `...` menus. No new colour; counts are numbers. Every string through `t()`. Check in a real browser at
  desktop and 360 px, light and dark, for Tasks F8 and P5. Everything off by default.
- Nothing outward: no push, no publish, no tag, no site deploy without the maintainer's go-ahead.

## Review Focus
Five failure modes no happy-path test would exercise; each has its test in the owning task.
1. **Hostile text in the scanners.** Pathological dot, `@`, `%`, bracket and label runs, a 100 000-character string, huge hosts, nested
   defang forms, bidi and zero-width characters inside a host: linear step counts, no throw, no regex from data, offsets that still map
   to the original line for masking. Parser differentials: `google.com@evil.com`, `evil.com\@google.com`, `%65vil.com`, decimal and hex
   IPs, IDN look-alikes. Tasks F2, F3.
2. **False positives on legitimate text, and allow lists that allow too much.** Scores, levels, coordinates, `v1.2.3`, `e.g.`, `file.md`,
   missing-space sentences (`this.is`), `100 200 300 400`; a game's own domain and its subdomains; `allow: github.io`. A must-match and a
   must-not-match corpus run in F2 and F3, and the same corpus drives the F4 and F8 dry run. Tasks F2, F3, F4.
3. **A filter report leaking into reporter machinery, or flooding the queue.** Every reader of `reporterSubject` (accuracy, tally,
   outcomes, bulk dismiss, notices on decision, suspension, ranking, AI act, hub reporter panel, Discord and webhook bodies) must treat
   `origin` reports as having no reporter; one open per person and room; a daily cap shared across processes. Tasks F5, F6.
4. **A partial erase.** Any table, in-memory index or queued write that still names the person afterwards; an alias set; a stale process
   that recreates an identifier; the audit rewrite; the safety remainder and its automatic finish; a held report under erase; a person
   erased twice. Tasks P1, P2.
5. **Hold and bundle.** Every purge (reports, sanctions, notices, decisions, appeals, AI rows, audit) and erase must skip the held set;
   the bundle must hold no hash, key, address or other player's id, must be byte-stable (canonical JSON), must verify, and must fail
   verification after one changed byte; owner-only enforced in core and http. Tasks P3, P4.

## Order and parallelism
Step 0 first. F1, F2, F3 and P1 are independent and can run at once (P1 reads the other themes' store changes). F4 follows F1, F2, F3.
F5 follows F1 and F4. F6 follows F4 and F5. F7 follows F4 and F6 (wire shapes can start early). F8 follows F6 and F7. P2 follows P1.
P3 follows P1 (it can run beside P2). P4 follows P2 and P3. P5 follows P4. P6 is last of the privacy side and follows P4; its filter
paragraph follows F7. F5 and P1 write their migration blocks at different times: whichever lands second rebases the shared migration.

---

### Task F1: Settings: `filters`
Spec 4.1, Rulings 1, 2, 3, 5, 7, 9, 14. Needs Step 0.
- **Files:** `packages/core/src/filters.ts` (new: types, `FILTER_ACTIONS`, `FILTER_LIMITS`, `checkFilters`, `resolveFilters`, `mergeFilters`,
  `overlayFilters`, `FILTER_SUGGESTIONS`, `SHARED_HOSTING_SUFFIXES`, domain and pattern *grammar* checks only; the scanners are F2 and F3),
  `packages/core/src/profile.ts` (`TOP_KEYS` and `OPTIONAL_TOP_KEYS` gain `filters`; `ModerationProfile.filters?`, `ResolvedProfile.filters`,
  `PolicyLayer.filters?`; `POLICY_SECTIONS` appends `'filters'`; `applyLayer`, `layerSections`, `changedSections` follow; the rule-number check
  runs where `autoRestrictRule` is checked), `packages/http/src/admin/policyProfile.ts` (route comment), tests
  `packages/core/test/filters-settings.test.ts`, `filters-merge.test.ts`, `policy-layer-filters.test.ts`, `packages/http/test/admin.policy-filters.test.ts`.
- **Interfaces (Produces):** `FilterSettings`, `LinkSettings`, `PersonalInfoSettings`, `PhraseRuleSettings`, `RatioSettings`,
  `ResolvedFilters` (all fields filled; `links`, `personalInfo`, `ratio` are `null` when off; `phrases` is `[]` when none), the limits as
  constants, `mergeFilters(base: ResolvedFilters, over: FilterSettings): ResolvedFilters` (a field left out inherits, `null` turns off,
  arrays and objects replace whole), `overlayFilters(base, patch)` for the rooms theme. Errors are `ProfileError` with the path
  (`filters.links.allow[3]`), never echoing a value.
- **Tests (names):**
  - `defaults: filters absent resolves to every block off, flagCapPerDay 50, ignore empty`; `presets ship filters unset`
  - `action is required on links, personalInfo, phrase rules and ratio; each of the four actions accepted; an unknown one refused with the path`
  - `rule defaults: links 4, personalInfo 2, phrases 4, ratio 4; a rule that is not an active Community Rule is refused naming filters.links.rule`
  - `domain entries: lowercased, a scheme, path, space, port, wildcard or empty entry refused; = prefix accepted; 100 accepted and 101 refused; a domain on both lists refused`
  - `allow: github.io, vercel.app and the whole shared-hosting list refused unless written =name.github.io; example.com and cdn.example.com accepted`
  - `phrase rules: id grammar and uniqueness; 20 rules and 21 refused; 100 patterns per rule and 500 in all; label over 40 refused; empty phrases refused`
  - `pattern grammar: alternation up to 8; a * or ~ first token refused; a first word under 3 letters refused; more than 6 tokens, more than 2 ~, an 81 character pattern refused; a pattern that folds to nothing refused; no regular-expression character class is accepted as syntax`
  - `ratio numbers: caps minLetters 8..200 and maxPercent 50..100, repeats 3..50, emoji 1..50, mentions 1..20, each edge accepted and the next refused; NaN, 2.5, a string refused`
  - `personalInfo: kinds subset, phone formatted|any, address count|flag only; address 'refuse' or 'mask' refused`
  - `newAccountDays 1..365 or null; flagCapPerDay 1..500`; `ignore: 50 entries of 1..60 characters`
  - `unknown keys refused with their path; non-plain objects, arrays where objects belong, getters read once`
  - `mergeFilters: left out inherits, null turns off, phrases replaced whole, links replaced whole not by member; the inputs are not changed or shared`
  - `a layer beats the code profile, which beats the defaults; reset("filters") restores the base; changedSections lists filters; a save audits policy.update with sections ["filters"] and no values`
  - `FILTER_SUGGESTIONS validate and resolve; none is applied by default`; `agentBrief and policyJson are unchanged by an unset filters`
  - http: `PUT /policy/profile with filters: 200; 409 stale; 400 invalid_profile with layer.filters.links.allow[0]; DELETE ?section=filters resets`
- **Run:** `npx vitest run packages/core/test/filters-settings.test.ts packages/core/test/filters-merge.test.ts packages/core/test/policy-layer-filters.test.ts packages/core/test/policy-layer.test.ts packages/core/test/golden.test.ts packages/http/test/admin.policy-filters.test.ts`

### Task F2: The link scanner
Spec 4.4, 9, Review Focus 1 and 2, Rulings 7, 8. Pure functions, no state. Independent of F1 except the list types.
- **Files:** `packages/core/src/filters/links.ts` (new: `scanLinks`, `judgeLink`, `parseHost`), `filters/lists.ts` (new: the strong and weak TLD
  lists, the invite pack, the shortener pack, the shared-hosting suffixes re-exported to F1; all literal data, each with a comment saying why
  excluded entries are excluded), `filters/chars.ts` (new: `stripHidden` with an offset map, the defang and dot-variant table), tests
  `packages/core/test/filters-links.test.ts`, `filters-links-corpus.test.ts`, `filters-links-hostile.test.ts`, `filters-static.test.ts`.
- **Interfaces (Produces):**
  `scanLinks(text: string): LinkCandidate[]` with `LinkCandidate { start: number; end: number; host: string | null; shape: 'host' | 'ip' | 'ipv6' | 'invalid'; path: string; scheme: string | null }`
  (`start`/`end` on the ORIGINAL text; at most 20 candidates, the rest ignored); `judgeLink(c: LinkCandidate, cfg: ResolvedLinks, accountIsNew: boolean): 'deny' | 'invite' | 'shortener' | 'unlisted' | 'new_account' | null`;
  `parseHost(authority: string): { host: string; ok: boolean }` (exported for tests).
- **Behaviour:** exactly spec 4.4: candidate rules (scheme, `www.`, strong TLD, weak TLD only with a path, IPv4, integer hosts), the defang
  and dot variants, hidden characters stripped with an offset map, the last-`@` host rule, `%XX` decoding only to LDH, lowercase NFKC, trailing
  dot, label and host length limits, the decision order deny, allow, packs, unlisted, an IDN host always unlisted. Never fetches, resolves or
  throws; a hard cap of 2 000 characters read and a step counter exposed through a test-only hook (`__scanSteps`).
- **Tests (names):**
  - `candidates: scheme, www, strong TLD bare, weak TLD only with a path, IPv4 with and without a port, a decimal IP host with a scheme`
  - `not links: 1.2.3, 3.14, v1.2, e.g., i.e., readme.md, file.zip, notes.py, this.is, check.in, ok.so, a sentence with a missing space after a full stop, a name@mail.com`
  - `defang and dots: [.] (.) {.} ideographic and full-width dots, hxxp and hxxps, (dot) and [dot] only before a strong TLD, a space after a dot is not read`
  - `host rules: the last @ wins (google.com@evil.com is evil.com), a port is dropped, brackets give ipv6 that is never allowable, %65vil.com decodes, %2F or a non-LDH decode is invalid and still a link, uppercase and trailing dots fold, a 64 character label and a 254 character host are invalid`
  - `hidden characters: zero-width, bidi and control characters inside a host are stripped; start and end still index the original text so a mask covers them`
  - `judge: deny beats allow; allow matches the host and its subdomains; = is exact; invites and shorteners hit unless allowed; unlisted acts or passes by the setting; new_account acts despite unlisted allow, never over the allow list; an IDN host is unlisted even when unlisted is allow; an invite on a path (discord.com/invite/x) hits while discord.com alone does not`
  - `a corpus of 80 must-match and 80 must-not-match lines (synthetic domains) passes, listed in the test file with a comment per surprising row`
  - `hostile: 100 000 characters of dots, a.a.a., @@@@, %%%%, [[[[, ))))), 2 000 labels, nested [[.]]: no throw, finished candidates at most 20, steps for 2n at most 2.5 times steps for n, per family`
  - `static: no "new RegExp" under src/filters; every regex literal in src/filters is in the reviewed list (the test reads the sources and compares)`
  - `the same input always gives the same candidates (no state, no clock)`
- **Run:** `npx vitest run packages/core/test/filters-links.test.ts packages/core/test/filters-links-corpus.test.ts packages/core/test/filters-links-hostile.test.ts packages/core/test/filters-static.test.ts`

### Task F3: Personal-info, ratio and phrase engines
Spec 4.5, 4.6, Review Focus 1 and 2, Ruling 6. Pure functions. Independent of F1/F2 except types.
- **Files:** `packages/core/src/filters/fold.ts` (new: `foldChunks(text): Chunk[]` with `{ folded, start, end }` on the original text, the look-alike map,
  accent and repeat folding), `filters/phrases.ts` (new: `parsePattern`, `compilePhrases(rules)`, `matchPhrases(compiled, chunks)`),
  `filters/personal.ts` (new: `scanPersonal`: email, phone, card with Luhn, contact, address), `filters/ratio.ts` (new: `scanRatio`, `soften`),
  tests `packages/core/test/filters-fold.test.ts`, `filters-phrases.test.ts`, `filters-personal.test.ts`, `filters-personal-corpus.test.ts`,
  `filters-ratio.test.ts`, `filters-hostile.test.ts`.
- **Interfaces (Produces):** `FilterSpan { start: number; end: number }`; `scanPersonal(text, cfg: ResolvedPersonalInfo): Array<{ detail: 'phone'|'email'|'card'|'contact'|'address'; span: FilterSpan }>`;
  `compilePhrases(rules: ResolvedPhraseRule[]): CompiledPhrases` (cached by settings identity); `matchPhrases(c: CompiledPhrases, text: string): Array<{ ruleId: string; span: FilterSpan }>`;
  `scanRatio(text, cfg): Array<{ detail: 'caps'|'repeats'|'emoji'|'mentions' }>`; `soften(text, cfg): string`.
- **Behaviour:** exactly 4.5 and 4.6. Phrase matching indexes by first folded word, then compares tails (`*`, `~` at most 3 words, prefix `*`,
  alternation). Emoji count uses one reviewed `\p{Extended_Pictographic}` literal (in the static list). `soften`: caps lowercased except the first
  letter of a sentence, a run cut to `maxRun`, emoji and mentions cut to `max`; the result is never longer than the input.
- **Tests (names):**
  - `fold: g0ld, g.o.l.d, goooold, accents, full-width letters, zero-width characters and look-alikes fold to gold; 500 and 2000 stay numbers; a chunk with no letter is never leet-mapped; spaced-out letters do not fold together`
  - `fold offsets: every chunk's start and end index the original text, including after stripped characters`
  - `patterns: whole word, alternation, prefix *, one-word *, ~ zero to three words; buy ~ gold matches buy gold, buy some gold, buy lots of cheap gold and not buy a very very cheap gold; two ~ at most; the order of words matters`
  - `phrase performance: 500 patterns, a 200 character line, steps bounded and independent of the pattern count beyond the first-word bucket`
  - `phone formatted: +44 20 7946 0958, (555) 010-9999, 555-010-9999, 555.010.9999, +1 555 010 9999 match; 100 200 300 400, 10 20 30 40, 1500 2000, 3-1, 2024-11-17, 12:30:45, 100/200/300, 40.7128 -74.0060 do not; any matches 9 to 15 digit runs and its false positives are listed in the test`
  - `card: a Luhn-valid 16 digit number with spaces or dashes matches; the same digits failing Luhn do not; 12 and 20 digits do not`
  - `email: a@b.com, a.b+c@mail.example, a [at] b [dot] com, a(at)b(dot)com match; a bare " at " never; a@b (no TLD) does not`
  - `contact: my snap is john_doe99, add me on discord name#1234, insta @tarvo_x match; discord is down, I love snap, snapchat is cool, signal strength do not`
  - `address: 221 Baker Street, 10 Downing St match as address only when address is on; the detector never reports a refusal-capable kind (the action cap is F1's)`
  - `ratio: caps over 70 percent of 12 or more letters; 11 letters never; repeats 7 of one character; emoji over 8 counting ZWJ sequences once; mentions over 3; soften output for each; soften never grows the text`
  - `hostile: 100 000 characters of digits, separators, @, #, ~, emoji and capitals: no throw, 2n steps at most 2.5 times n steps; the phrase compiler refuses nothing it already accepted in F1 and never throws on a validated rule`
  - `a corpus of must-match and must-not-match lines per detector (scores, levels, coordinates, version numbers, prices, dates, ids) passes`
  - `static: no new RegExp; literals in the reviewed list` (extends F2's list file)
- **Run:** `npx vitest run packages/core/test/filters-fold.test.ts packages/core/test/filters-phrases.test.ts packages/core/test/filters-personal.test.ts packages/core/test/filters-personal-corpus.test.ts packages/core/test/filters-ratio.test.ts packages/core/test/filters-hostile.test.ts packages/core/test/filters-static.test.ts`

### Task F4: The engine, the chat path and the counters
Spec 3, 4.2, 4.3, 4.7, 9, Rulings 4, 11, 13, 25. Needs F1, F2, F3.
- **Files:** `packages/core/src/filters/engine.ts` (new: `createFilterEngine({ settings, accountAgeDays, canonical, clock, logger })`,
  `evaluate(roomId, text, ctx)`, `FilterVerdict`), `filters/counters.ts` (new: the in-memory day/key/action counters, `drain()`, a 30 second
  flush timer owned by the facade), `packages/core/src/chat.ts` (new `ChatServiceDeps.filters` and `onFilterFlag`; the call after the matcher branch and
  before profanity; `RefuseReason` gains `link | personal_info | filter`; `mask` composition; a thrown engine fails open), `packages/core/src/chatwarden.ts`
  (wires the per-room settings getter like `pace`, `cw.filters.test(text, candidate?)`, `cw.filters.check(candidate, lines)`, `cw.filters.stats({ days })` reading
  the store through F5's methods, the flush timer and `close()` flush), `index.ts`, tests `packages/core/test/filters-engine.test.ts`,
  `chat-filters.test.ts`, `filters-counters.test.ts`, `filters-failopen.test.ts`, `filters-parity.test.ts`.
- **Interfaces (Produces):** `FilterVerdict { hits: FilterHit[]; refuse: { reason: 'link'|'personal_info'|'filter'; rule: number } | null; spans: FilterSpan[]; softened: string | null; flags: FilterHit[] }`;
  `FilterHit { key: string; kind: 'link'|'personal_info'|'phrase'|'ratio'; detail: string; action: FilterAction; rule: number; spans: FilterSpan[] }`;
  `ChatServiceDeps.filters?: { settings: (roomId: string) => ResolvedFilters; accountIsNew?: (subject: SubjectId | null) => boolean; count: (hit: FilterHit) => void }`;
  `ChatServiceDeps.onFilterFlag?: (info: { roomId: string; seatId: string; subject: SubjectId; lineId: string; hit: FilterHit }) => void` (fenced).
- **Behaviour:** exactly 4.3: strongest action, the first refusing hit by the fixed order, every `mask` span applied then profanity on the masked
  text, all blocks run, off builds nothing. A refused line is not buffered and makes no strike. A `flag` calls `onFilterFlag` after the buffer append, with at most one
  call per line (the strongest-ranked flag). The account-age hook is called only when an unlisted link is present and `newAccountDays` is set, fenced, unknown is not new. A throw in
  the engine logs `chatwarden.filter_failed` by class at most once a minute and the line goes on unfiltered.
- **Tests (names):**
  - `off: with filters unset the engine builds no key, calls nothing and every chat script gives the same results as before the module`
  - `order: a matcher hit returns blocked first and the filters never run; filters then profanity; a refused line spends rate and pacing budget like a profane one`
  - `refuse: link, personal_info and filter reasons with the rule of the hit; no text in the result; the line is not in the buffer; no strike, no sanction, no notice, no event`
  - `precedence: refuse beats mask beats flag beats count; two refusing rules cite the first in link, personal info, phrase list order, ratio order; every hit still counts`
  - `mask: link and personal info spans become * on the delivered text, raw stays in the buffer; ratio soften; profanity star runs on the masked text; a line that is all mask still delivers`
  - `count: the line is untouched and counted; flag: the line delivers and onFilterFlag is told once with its lineId; a guest speaker counts only`
  - `ignore phrases are blanked before any block reads; an ignored phrase inside a link leaves the rest readable`
  - `per-room settings: the getter is called with the room id and a different result changes the next line`
  - `account age: the hook is called only for an unlisted link with newAccountDays set; null, undefined and a throw read as not new; a new account is acted on despite unlisted allow and still passes the allow list`
  - `counters: one increment per hit by day, key and action; flush on the timer and on close; stats flushes this process first; flag_capped counted when the cap turns a flag into a count; a failing store flush is logged by class and retried`
  - `fail open: a throwing engine and a throwing hook let the line through, log once a minute by class, and never throw out of accept`
  - `a spy logger sees event names and error classes only: no line, domain, pattern or id`
  - `cw.filters.test returns the verdict with spans for the live settings and for a candidate; check counts per rule over lines with at most 20 samples per rule; neither writes anything or touches the clock-driven counters`
  - `scripts/browser-bundle.test.ts budget holds with the engine statically imported; if it fails the failure message names the dynamic import fallback of Ruling 25`
- **Run:** `npx vitest run packages/core/test/filters-engine.test.ts packages/core/test/chat-filters.test.ts packages/core/test/filters-counters.test.ts packages/core/test/filters-failopen.test.ts packages/core/test/filters-parity.test.ts packages/core/test/chat.test.ts packages/core/test/pace-chat.test.ts scripts/browser-bundle.test.ts`

### Task F5: `flag` reports, the stores and retention
Spec 4.7, 4.8, Review Focus 3, Rulings 12, 13. Needs F1 and F4. Writes migration-26 block 1 and 2.
- **Files:** `packages/core/src/types.ts` (`StoredReport.origin`, `originKey`; `ReportRecord` follows; required `Store` methods `addFilterHits(rows)`,
  `listFilterHits(sinceDay, untilDay)`, `purgeFilterHits(beforeDay)`, `countOriginReports(origin, since)`; `insertReport` documents the open-filter refusal),
  `packages/core/src/reports.ts` (`ReportService.fileSystem(input): Promise<'filed' | 'open_exists' | 'capped' | 'no_subject' | 'off'>`; the cap read from `countOriginReports`;
  the report built from the evidence buffer), `packages/core/src/ai/actPlan.ts` (`isSystemReport` reads `origin`), every reader of the reporter fields found by
  `rg "reporterSubject|reporter_subject|reporterSeat|reporterHandle"` across `packages/*/src` (reporter tally, `reporterOutcomes`, `reporterAccuracy`,
  `listOpenReportsByReporter`, `dismissMany`, the reporter notice on decision, suspension, the case ranking, staff views), `packages/core/src/events.ts`
  (`report.created.origin?`), `packages/core/src/retention.ts` (`filterHitsMs` 90 days, floor 30; `purge` calls `purgeFilterHits`; `PurgeResult.filterHits`),
  `packages/store-memory/src/memoryStore.ts` (the four methods and the open-filter refusal), `packages/store-sqlite/src/migrations.ts` and `sqliteStore.ts`
  (migration-26 blocks 1 and 2, prepared statements; `addFilterHits` is one `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + excluded.hits` per row), `test/contract/filters.contract.ts`
  (registered in `test/contract/index.ts`), tests `packages/core/test/reports-filter.test.ts`, `reporter-machinery-filter.test.ts`, `retention.test.ts` additions,
  `packages/store-memory/test/filters.store.test.ts`, `packages/store-sqlite/test/filters.store.test.ts`, `filters.migration.test.ts`.
- **Interfaces (Produces):** `ReportRecord.origin: 'filter' | 'watch' | null`, `originKey: string | null` (closed shape `[a-z0-9_.:-]{1,48}`);
  `cw.reports.fileSystem({ origin: 'filter', originKey, roomId, target: SubjectId, lineId: string | null, reportedReason: 'spam' | 'personal_info' })`;
  `FilterHitRow { day: number; key: string; action: FilterAction | 'flag_capped'; hits: number }`.
- **Behaviour:** as 4.8. The report has `reporterSubject = filter:<report id>`, empty seat and handle, null note, status open, the room's evidence excerpt, reason `spam`
  or `personal_info`, `origin 'filter'`, `originKey` the counter key. One open per (person, room) by the partial unique index; the daily cap is `flagCapPerDay` counted by `countOriginReports('filter', startOfUtcDay)`.
  `report.created` is emitted as for any report with `origin`. No reporter notice, accuracy, suspension, bulk dismiss, ranking or AI act touches it. `onFilterFlag` (F4) calls `fileSystem`
  and counts `flag` or `flag_capped`/`count` by the result.
- **Tests (names):**
  - `fileSystem files one open report with origin filter, no note, the excerpt of the room, reason spam for link, phrase and ratio and personal_info for personal info`
  - `a second flag for the same person and room while one is open answers open_exists and files nothing; after the first is decided a new one files`
  - `the daily cap: at flagCapPerDay the next answers capped; the count reads the store so a second cw on the same store shares it; the UTC day edge is exact`
  - `a guest (no subject) answers no_subject and files nothing; moderation switched off answers off`
  - `every reporter reader ignores origin reports: reporterAccuracy, reporterTally, reporterOutcomes, listOpenReportsByReporter, dismissMany by reporter, the suspension count, the decision's reporter notice, habitual-reporter ranking, the AI act check system_report; a distinctive filter: reporter value appears in none of their outputs`
  - `StaffReport for a filter report has reporter null, origin and originKey; the player-facing bodies carry nothing new (no-leak)`
  - `report.created carries origin filter and no text; an ordinary report carries none`
  - `retention: filterHitsMs default 90 days, below 30 refused naming retention.filterHitsMs; purge deletes day rows strictly older and reports filterHits; reports of origin filter purge on reportsMs`
  - store contract: `addFilterHits adds to an existing (day, key, action); listFilterHits by day range; purge strict edge; countOriginReports counts by origin since a time; insertReport refuses a second open filter report for one (target, room) and accepts it once the first is closed; an ordinary report is unaffected`
  - sqlite: `migration 26 blocks 1 and 2 from an earlier database keep every report row and add the columns, indexes and kit_filter_hits; the partial unique index is used by the insert (EXPLAIN QUERY PLAN); memory and sqlite give the same answers on the differential script`
- **Run:** `npx vitest run packages/core/test/reports-filter.test.ts packages/core/test/reporter-machinery-filter.test.ts packages/core/test/retention.test.ts packages/core/test/reporter-accuracy.test.ts packages/store-memory/test/filters.store.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/filters.store.test.ts packages/store-sqlite/test/filters.migration.test.ts packages/store-sqlite/test/contract.test.ts`

### Task F6: HTTP, filters routes and report bodies
Spec 4.9, 8. Needs F4 and F5.
- **Files:** `packages/http/src/admin/filters.ts` (new `filterRoutes(ctx, recentLines)`), `admin/index.ts` (registered), `permissions.ts` (`filters.read: 'moderator'`),
  `packages/hub-react/src/types.ts` (`PermissionKey`), `admin/policyProfile.ts` (`GET /policy/profile` gains `limits.filters.accountAge`), the report handlers
  (`origin`, `originKey`, `reporter: null`), `webhooks/*` (the `report.created` body's `origin`), `packages/discord/src/feed.ts` (a filter report posts as "Filter: Links", no reporter line),
  route doc comments, tests `packages/http/test/admin.filters.test.ts`, `admin.reports-filter.test.ts`, `webhooks.filter.test.ts`, `packages/discord/test/feed.filter.test.ts`, `admin.every-route.test.ts`.
- **Routes:** `GET /filters/stats?days=7|30` (`filters.read`, no audit: counts only); `POST /filters/test { text, candidate? }` (`filters.read`, nothing stored or audited, `text` 1 to 2 000
  characters); `POST /filters/check { candidate }` (`filters.read`; uses `recentLines()`, at most 5 000 lines, answers counts and at most 20 samples per rule). A `candidate` is validated like the layer
  (400 `invalid_filters` with the path, never the value). All bodies `no-store`.
- **Tests (names):**
  - `permission boundaries at moderator, senior and owner; filters.read lowered or raised by the permissions option works; an unknown key is still refused`
  - `GET /filters/stats: windows 7 and 30 only; 400 invalid_query otherwise; rows per key with counts by action and the rule's label for phrase keys; empty with no data`
  - `POST /filters/test: the verdict with kinds, details, actions, rules and spans; a candidate that is invalid is 400 with the path; nothing is written (spy store); no audit row; the text is not logged`
  - `POST /filters/check: counts and at most 20 samples per rule; 400 for a bad candidate; with no recentLines option it answers empty counts`
  - `GET /me can[] has filters.read; GET /policy/profile reports limits.filters.accountAge true only when the hook is configured`
  - `a filter report in GET /reports, GET /reports/:id and the queue has reporter null, origin and originKey and no reporter accuracy; takeNext and the case claim work as for any report`
  - `report.created webhooks and the Discord post carry the origin and no line; the Discord post has no reporter line`
  - `every-route test lists the new routes; every response is no-store JSON`
- **Run:** `npx vitest run packages/http/test/admin.filters.test.ts packages/http/test/admin.reports-filter.test.ts packages/http/test/webhooks.filter.test.ts packages/http/test/permissions.test.ts packages/http/test/admin.every-route.test.ts packages/discord/test/feed.filter.test.ts`

### Task F7: Player words, the chat wire, the example and the filter docs
Spec 4.10, 8. Needs F4 and F6 (wire shapes can start early).
- **Files:** `packages/http/src/chat/wire.ts` (the three reasons on the refusal), `packages/player-react/src/chat/Composer.tsx` (`KNOWN` set), `chat/words.ts` and `i18n.ts`
  (`player.refuse.link`, `player.refuse.personal_info`, `player.refuse.filter`; the rule label appended as for `blocked`), `RestrictedChatLine.tsx` if it names reasons,
  `packages/core/README.md` (filters section), `packages/http/README.md` (routes), `packages/player-react/README.md` (words), `examples/tiny-chat` (`CW_DEMO_FILTERS=1` turns on links
  `flag` plus personal info `mask`, and a phrase rule), tests `packages/http/test/chat.filters.test.ts`, `packages/player-react/test/chat-filter-words.test.tsx`, `examples/tiny-chat/filters.test.ts`,
  `scripts/readme.test.ts` expectations, the player-react `static.test.ts` export lock.
- **Tests (names):**
  - `the chat route answers refuse { reason: link | personal_info | filter, rule } and never the matched text, a pattern or a counter`
  - `the composer shows each reason in words with the rule label; an unknown reason falls back to the generic sentence; both catalogs (en and fallback) have every key`
  - `a masked line shows the author the delivered text; nothing in the box says which pattern matched`
  - `no identifier appears in any answer (no-leak); size.test.ts budget holds`
  - `tiny-chat with CW_DEMO_FILTERS refuses a link, masks a phone number and files a flag report a second moderator sees with reporter null; without the variable none of it exists`
  - `the readme checks pass`
- **Run:** `npx vitest run packages/http/test/chat.filters.test.ts packages/player-react/test/chat-filter-words.test.tsx packages/player-react/test/no-leak.test.tsx packages/player-react/test/static.test.ts packages/player-react/test/size.test.ts examples/tiny-chat/filters.test.ts scripts/readme.test.ts`

### Task F8: hub-react, Settings, Advanced, "Chat filters" and the queue chip
Spec 4.11, Rulings 1, 3. Needs F6 and F7. Read first: `screens/PaceSettings.tsx`, `screens/AdvancedSettings.tsx`, `policyHooks.ts`, `terms/Tester.tsx`, `terms/HitsConfirm.tsx`, `lazyParts.tsx`.
- **Files:** `packages/hub-react/src/screens/FilterSettings.tsx` (lazy panel) with `filters/LinkCard.tsx`, `PersonalInfoCard.tsx`, `RatioCard.tsx`, `PhraseCard.tsx`,
  `FilterTester.tsx`, `FilterHits.tsx`, `lazyParts.tsx` and `screens/AdvancedSettings.tsx` (one more `Lazy...` after the others), `policyHooks.ts` (`layer.filters`), `client.ts`
  (`filterStats`, `filterTest`, `filterCheck`), `types.ts`, `labels.ts` (the queue chip text from `originKey`), `QueueRow.tsx` and `case/CaseContext.tsx` (the chip where a reporter would show;
  `reporter: null` handled everywhere the reporter renders), `i18n.ts` (`hub.settings.filters.*`, `hub.report.origin.*`), tests `filter-settings.test.tsx`, `filter-tester.test.tsx`,
  `filter-queue-chip.test.tsx`, `a11y-filters.test.tsx`, `lazy-screens.test.tsx`, `api.test.ts`, `size.test.ts`.
- **Behaviour:** as 4.11. Off means the panel shows four switches off; each card hides its details until on. The action choice is words, not codes; refuse and mask show one sentence of
  consequence. "Test a message" calls `POST /filters/test` with the unsaved candidate and highlights ranges; "Check my changes" calls `POST /filters/check` and asks for a confirm over 5%.
  "Use suggested values" fills and does not save. Saving sends the whole layer with a reason; a 409 offers a reload. Only the owner edits; others read. A hint appears under the new-account
  setting when `limits.filters.accountAge` is false.
- **Tests (names):**
  - `defaults to every block off; only the owner can save; others see values read-only; saving sends the whole layer with filters merged and a reason; a 409 offers to reload; reset restores the base`
  - `each card validates as the server does (domain, pattern, numbers) with the server's path shown in words; the allow-list shared-hosting refusal reads "list the exact name with ="`
  - `Test a message sends the unsaved candidate, shows kind, action and rule in words and highlights the ranges; nothing is saved`
  - `Check my changes lists counts and samples, asks for a confirm when refuse or mask touches over 5 percent, and keeps what was typed on an error`
  - `Hits is collapsed by default and shows counts as numbers with no band or colour; flag_capped reads "not filed (daily limit)"`
  - `use suggested values fills the form and does not save`
  - `a filter report shows "Filter: Links" or the phrase label as a neutral chip, no reporter panel, no reporter accuracy, and the case behaves as any case; an older body with a reporter renders as before`
  - `Simple mode and the nav are unchanged (DOM snapshot); the panel is lazy and the main chunk gains no filter code`
  - `axe: no violations, light and dark; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/filter-settings.test.tsx packages/hub-react/test/filter-tester.test.tsx packages/hub-react/test/filter-queue-chip.test.tsx packages/hub-react/test/a11y-filters.test.tsx packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task P1: The privacy registry and the store contract
Spec 5.1, 5.4, Review Focus 4, Rulings 15 to 19, 23, 24. Writes migration-26 blocks 4 and 5. Read first: every migration's DDL, `SubjectIndex`, `store-memory/src/memoryStore.ts`.
- **Files:** `packages/core/src/privacy.ts` (new: `PRIVACY_CATEGORIES`, `PRIVACY_REGISTRY` (category, tables, export, eraseSafety, eraseNone), `PrivacyExport`, `ErasePlan`, `ErasureCounts`, `ErasureReceipt`, `ErasePreview`),
  `packages/core/src/types.ts` (required `Store` methods `exportSubjects(subjects): SubjectExport`, `eraseSubjects(plan): ErasureCounts`, `insertErasure`, `loadPendingErasures`, `finishErasure`, `erasureEpoch`;
  `saveIdentifier` documented as a no-op for a subject that does not exist), `packages/store-memory/src/memoryStore.ts` (the methods, built in; the old `withMemory*` opt-in wrappers are dropped where this
  plan touches them: none exist for privacy), `packages/store-sqlite/src/migrations.ts` and `sqliteStore.ts` (migration-26 blocks 4 and 5; `saveIdentifier` conditional; one prepared statement per category),
  `test/contract/privacy.contract.ts` (registered), tests `packages/core/test/privacy-registry.test.ts`, `packages/store-memory/test/privacy.store.test.ts`, `packages/store-sqlite/test/privacy.store.test.ts`,
  `privacy.migration.test.ts`, `privacy.registry-complete.test.ts`.
- **Behaviour:** the registry is the one place that says what each category does. `exportSubjects` and `eraseSubjects` take the full alias set; `eraseSubjects` is one transaction in both stores, applies 5.1 per category
  and mode, sets `sanction.report_id` NULL where its report was deleted, replaces an erased reporter by `erased:<report id>` and the person's lines in others' reports by a marker, never touches a row of a held
  report (P3 supplies the hold set; here the plan takes `heldReportIds: ReadonlySet<string>`), bumps `erasureEpoch`, and returns counts per category. With `safety` it computes the in-force sanction set and keeps exactly the
  subject, identifier and sanction rows of 5.3. `insertErasure` writes the receipt row with `pending_subject` set only while a remainder is kept.
- **Tests (names):**
  - `registry: every PRIVACY_CATEGORIES entry has an export and an erase rule for both modes; the registry text is what GET /privacy/statement will show`
  - `completeness (sqlite): every kit_ table in sqlite_master is in the registry map or in a short "holds no person" list with a reason; adding a table without an entry fails`
  - `no id survives (contract, both stores): a person with an alias, an account id, a key, an address row, a sanction (in force and ended), notices, strikes, mutes (placed and received), a blocked name, an appeal, signals (about and by), a claim, a Discord thread, an AI mark, reports (filed, about, and a line inside a third party's report) is erased with none: a dump of every table holds none of their ids, accounts, handles or lines`
  - `safety: a person with a ban in force keeps the subject, identifiers and that sanction and notice (excerpt cleared) and loses everything else; the receipt row has pending_subject; a person with only ended sanctions loses the identifiers too`
  - `an erased reporter's report stays for its target with the reporter, seat, handle and note removed; a report about the person is deleted with its decisions, AI rows and links; sanction.report_id is NULL after`
  - `held report ids passed in are untouched, with their excerpt lines, under none`
  - `export: returns accounts as given, counts of keys and addresses, no hash, no other player's id or handle or lines, no reporter identity, no staff ref, mutes as counts; 5 001 strikes give 5 000 and truncated`
  - `saveIdentifier for a subject that does not exist writes nothing; erasureEpoch moves on every erase and on nothing else`
  - `an unknown subject erases nothing and writes no receipt; erasing twice is a no-op the second time`
  - `migration 26 blocks 4 and 5 from an earlier database add kit_erasures, the epoch row and the indexes and keep every row; the differential script gives the same counts in memory and sqlite`
- **Run:** `npx vitest run packages/core/test/privacy-registry.test.ts packages/store-memory/test/privacy.store.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/privacy.store.test.ts packages/store-sqlite/test/privacy.migration.test.ts packages/store-sqlite/test/privacy.registry-complete.test.ts packages/store-sqlite/test/contract.test.ts`

### Task P2: `cw.privacy`: find, export, erase, the in-memory fix-ups and the finish
Spec 5.2, 5.3, Review Focus 4, Rulings 15, 17, 18, 21, 23. Needs P1.
- **Files:** `packages/core/src/privacyService.ts` (new), `packages/core/src/subjects.ts` (`forget(subjects)`, `find(raw)` read-only, the epoch re-check at most every 30 seconds with a reload,
  conditional writes), `packages/core/src/evidence.ts` (`EvidenceBuffer.scrub(subjects)`, `RoomRoster.forget(subjects)` turning seats into guests), `sanctions.ts`, `mutes.ts`, `notices.ts`,
  `signalService.ts`, `pacing.ts`, claims and viewing hints (`forget` on each in-memory cache), `packages/core/src/retention.ts` (`purge` finishes pending erasures and drops stray rows older than 10 minutes
  whose subject row does not exist; `PurgeResult.erasuresFinished`, `strayRows`), `packages/core/src/audit.ts` (the six actions `privacy.find`, `privacy.export`, `privacy.erase`, `legal.hold`, `legal.release`,
  `legal.bundle` appended now so P3 and P4 share them; targets: person for `privacy.*`, report for `legal.*`), `chatwarden.ts` (`cw.privacy`, `statement()` from the registry and the live retention), `index.ts`,
  tests `packages/core/test/privacy-find.test.ts`, `privacy-export.test.ts`, `privacy-erase.test.ts`, `privacy-memory.test.ts`, `privacy-finish.test.ts`, `privacy-stale.test.ts`, `vocabulary-privacy.test.ts`.
- **Interfaces (Produces):** exactly the signatures of spec 5.2; `ErasureReceipt { id; at; mode; removed; kept: { identifiers: boolean; sanctions: number; heldReports: number }; auditFailed?: true }`;
  `PrivacyStatement { keeps: Array<{ category; mode; retentionMs: number | null }>; erases: ...; }`.
- **Behaviour:** `find` resolves a `RawWho` and never creates a subject. `export` flushes, resolves the alias set, calls the store, adds the registry's notes. `erase` follows 5.3 step by step: flush, resolve,
  dry run, one store transaction, then forget in memory, flush and sweep identifiers once more, then audit. A dry run writes nothing. `keep: 'safety'` leaves the pending subject for `purge()` to finish when the person has
  no sanction rows left. A second process reloads its subject index when the epoch changes.
- **Tests (names):**
  - `find: by account id and by client key finds the person; an unknown caller is null and no subject is created; an IP alone finds nobody`
  - `export: the sections of the registry; the same person through an alias gives the same export; an unknown subject is not_found; a guest-only person has empty sections`
  - `erase none: a connected player's next line makes a new unlinked subject and no row under the old id (strike, signal, notice, claim); their seat reads as a guest; their evidence lines lose text, handle and subject; the sanction and mute indexes forget them`
  - `erase safety: the ban still refuses the same key at the door afterwards; the receipt says identifiers kept; purge finishes the erase once the sanction rows are gone: identifiers and subject row deleted, audit refs rewritten to the receipt id, pending_subject cleared`
  - `the audit trail: before the finish the rows keep the subject ref; after, they read the receipt id; no other audit row is ever rewritten`
  - `a write queued for the person between flush and commit cannot survive: the second sweep removes it`
  - `a held report (P3's set) survives under none with its lines, and the receipt counts it`
  - `dryRun returns the counts of a real run and writes nothing, no receipt, no audit, no epoch move`
  - `two cw instances on one store: after one erases, the other reloads within 30 seconds on the fake clock and never writes an identifier for the dead subject; strays older than 10 minutes are dropped by purge and younger ones are kept`
  - `auditFailed: a failing audit write after the commit is returned in the receipt and logged by class, and the erase stands`
  - `a spy logger sees event names and error classes only; the receipt, the audit rows and the events hold no line, handle or hash`
  - `vocabulary: the six actions are last in AUDIT_ACTIONS; the order-lock test allows the append; privacy.* need a person target and legal.* a report target, privacy.find none; no detail is allowed`
  - `statement lists every category with the live retention clock and changes when retention changes`
- **Run:** `npx vitest run packages/core/test/privacy-find.test.ts packages/core/test/privacy-export.test.ts packages/core/test/privacy-erase.test.ts packages/core/test/privacy-memory.test.ts packages/core/test/privacy-finish.test.ts packages/core/test/privacy-stale.test.ts packages/core/test/vocabulary-privacy.test.ts packages/core/test/audit.test.ts packages/core/test/retention.test.ts`

### Task P3: Legal hold, the canonical bundle and `report.escalated`
Spec 6, Review Focus 5, Rulings 20, 21, 22. Needs P1; can run beside P2. Writes migration-26 block 3.
- **Files:** `packages/core/src/types.ts` (required `Store` methods `placeHold`, `releaseHold`, `loadHold`, `listHolds`, and `heldSet()` returning the held report ids and the sanction groups, notice groups,
  appeal groups and AI rows they protect), `packages/core/src/legal.ts` (new: `cw.legal.hold/release/bundle`, `HoldCode`), `packages/core/src/canonical.ts` (new: `canonicalJson(value): string`, `signBundle`, `verifyBundle`,
  exported `@experimental`), `packages/core/src/events.ts` (`report.escalated { reportId, at, code, target: StaffRef }`, appended to `KitEvent` and `KIT_EVENT_TYPES`), `packages/core/src/retention.ts`
  (every purge call and `eraseSubjects` get the held set; the store methods skip it), `chatwarden.ts` (`cw.legal`, the `bundleSecret` option, at least 32 characters, never logged), `packages/store-memory`,
  `packages/store-sqlite` (migration-26 block 3; the purge statements gain `NOT IN` the held subselects), `test/contract/legal.contract.ts` (registered), tests `packages/core/test/legal-hold.test.ts`,
  `legal-bundle.test.ts`, `canonical.test.ts`, `legal-purge.test.ts`, `vocabulary-legal.test.ts`, `packages/store-memory/test/legal.store.test.ts`, `packages/store-sqlite/test/legal.store.test.ts`, `legal.migration.test.ts`.
- **Interfaces (Produces):** `cw.legal.hold(reportId, { code: HoldCode; actor: string }): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'already_held' | 'invalid' }>`;
  `release(reportId, { actor }): Promise<{ ok: boolean }>`; `bundle(reportId, { actor, includeAccounts?: boolean }): Promise<EvidenceBundle | { ok: false; error: 'not_found' }>`;
  `EvidenceBundle` as spec 6; `canonicalJson(value: unknown): string`; `verifyBundle(bundle: EvidenceBundle, secret?: string): { sha256: boolean; hmac: boolean | null }`.
- **Behaviour:** as spec 6. A hold is placed in one transaction with its `report.escalated` event emitted after the commit (fenced). The held set is the report, its decisions, the sanction groups with `report_id` equal to it,
  their notices, the appeals on them, the AI reads, outcomes and actions for it, and the audit rows targeting the report or those groups. Canonical JSON: keys sorted (code point order), no whitespace, strings by
  `JSON.stringify`, integers as written, `-0` and non-finite numbers and `undefined` refused, no `toJSON`. The bundle lists `people` by index with the handle kept in the report and account ids only on request.
- **Tests (names):**
  - `hold: a senior-level actor string is accepted, a closed code only, no free text; an unknown report is not_found; a second hold is already_held; release by anyone clears it and writes the row`
  - `purge skips: reports, decisions, sanction groups (all rows including address rows), notices, appeals, AI reads, outcomes and actions, and audit rows of the held set, at every retention age; after release the next purge removes what is past retention`
  - `erase skips the held set (P2 consumes it); a held report's excerpt keeps another player's lines`
  - `report.escalated is emitted once after the commit with ids and a code only, never on a refusal, never on release; a failing listener cannot fail the hold; the webhook and Discord handling is in P4`
  - `bundle: holds no hash, raw key, address, other player's id outside the people index, staff-only free text beyond what the spec lists; accounts only with includeAccounts; statements only when still held`
  - `canonical JSON: key order, unicode, escapes, numbers, nested arrays; the same value gives the same bytes in memory and sqlite runs; a golden file with a fixed secret and clock; -0, NaN, Infinity, undefined and a Date are refused`
  - `integrity: sha256 and hmac verify; one changed byte in any field fails both; the wrong secret fails the hmac; with no bundleSecret hmacSha256 is null and verifyBundle says null`
  - `bundleSecret shorter than 32 characters throws at creation naming bundleSecret and never the value; the secret appears in no log line, body or error`
  - `vocabulary: report.escalated is last in KIT_EVENT_TYPES; cw.on accepts it; an unknown type still throws; the event shape holds no text (expectTypeOf)`
  - `a spy logger sees event names and error classes only`
  - `browser bundle: scripts/browser-bundle.test.ts budget holds`
  - sqlite: `migration 26 block 3 adds kit_legal_holds and its partial index and keeps every row; EXPLAIN QUERY PLAN: purge uses the held index; the purge statements still use their own indexes`
- **Run:** `npx vitest run packages/core/test/legal-hold.test.ts packages/core/test/legal-bundle.test.ts packages/core/test/canonical.test.ts packages/core/test/legal-purge.test.ts packages/core/test/vocabulary-legal.test.ts packages/core/test/events.test.ts packages/store-memory/test/legal.store.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/legal.store.test.ts packages/store-sqlite/test/legal.migration.test.ts packages/store-sqlite/test/contract.test.ts scripts/browser-bundle.test.ts`

### Task P4: HTTP, privacy, hold and bundle routes
Spec 5, 6, 8, Review Focus 5, Ruling 21. Needs P2 and P3.
- **Files:** `packages/http/src/admin/privacy.ts` (new `privacyRoutes(ctx)`), `admin/legal.ts` (new), `admin/index.ts`, `permissions.ts` (`legal.hold: 'senior'`; erase, export, find, release and bundle check the role `owner` in
  the handler, not a permission), `packages/hub-react/src/types.ts` (`PermissionKey`), the report handlers (`hold: { code, at } | null` on `GET /reports/:id` for a caller with `reports.read`), `webhooks/*` (`report.escalated` accepted in `events`,
  signed, no extra field; `includeAccounts` adds accounts as for `rename.required`), `packages/discord/src/feed.ts` (ignores it), `GET /me` (`can[]` has `legal.hold`; `role` already present), route doc comments, tests
  `packages/http/test/admin.privacy.test.ts`, `admin.legal.test.ts`, `webhooks.escalated.test.ts`, `player.no-privacy.test.ts`, `admin.every-route.test.ts`.
- **Routes:** `POST /privacy/find { accountId }` (owner; audits `privacy.find`, best-effort; 200 `{ ref | null }`); `GET /people/:ref/privacy/export` (owner; audit `privacy.export` required; JSON attachment, `no-store`);
  `POST /people/:ref/privacy/erase { keep: 'safety'|'none', confirm: <ref>, dryRun? }` (owner; `confirm` must equal the canonical ref or 400 `confirm_mismatch`; a dry run is not audited; 404 `not_found`; the receipt body);
  `GET /privacy/statement` (owner); `PUT /reports/:id/hold { code }` (`legal.hold`; audit `legal.hold` best-effort after the write; 409 `already_held`), `DELETE /reports/:id/hold` (owner; audit `legal.release`),
  `GET /reports/:id/bundle?accounts=1` (owner; audit `legal.bundle` required; JSON attachment, `no-store`).
- **Tests (names):**
  - `permission boundaries: moderator and senior get 403 on find, export, erase, statement, release and bundle; a senior may hold; the permissions option can lower legal.hold and cannot lower the owner-only routes; an unknown key is refused`
  - `audit modes: export and bundle fail the request when the audit write fails and send nothing; erase audits after the commit and reports auditFailed; hold and release best-effort`
  - `erase: 400 confirm_mismatch, 400 invalid_request for a bad keep or extra keys (forbid actor in the body), 404 for an unknown person, dryRun writes nothing and audits nothing; the body is the receipt only`
  - `export and bundle send content-disposition attachment and no-store; the bundle accounts only with accounts=1`
  - `no player route reaches cw.privacy or cw.legal: a table of every player route and its handler's reads, asserted by a spy cw`
  - `webhooks: report.escalated is accepted, signed, ids and a code only; includeAccounts adds accounts to it and to no other type except rename.required; an unknown event type is still refused; Discord posts nothing`
  - `GET /reports/:id has hold only for a held report; every other body is unchanged`
  - `every-route test lists the new routes; every response is no-store JSON except the two attachments, which are no-store too`
  - `the receipt, the statement and every error body contain no line, handle, hash, key or secret`
- **Run:** `npx vitest run packages/http/test/admin.privacy.test.ts packages/http/test/admin.legal.test.ts packages/http/test/webhooks.escalated.test.ts packages/http/test/player.no-privacy.test.ts packages/http/test/permissions.test.ts packages/http/test/admin.every-route.test.ts`

### Task P5: hub-react, Person and case menus, "Privacy requests"
Spec 5.2, 5.3, 6, Rulings 15, 21. Needs P4. Read first: `screens/Person.tsx` (the existing `...` menu and `person/Automation.tsx`), `ai/ActDialog.tsx` (the typed confirm), `screens/AdvancedSettings.tsx`, `lazyParts.tsx`.
- **Files:** `packages/hub-react/src/person/Privacy.tsx` (lazy: "Export data..." and "Erase data..." `...` items, the export download, the erase dialog), `person/ErasePreview.tsx`, `screens/PrivacySettings.tsx` (lazy Advanced panel: a find box
  by account id that opens the Person page, the statement table, the wording of what is kept), `case/Hold.tsx` (lazy: "Hold for legal..." and "Release hold..." `...` items and the dialogs with the closed code list; the quiet "Held for legal" line),
  `client.ts`, `types.ts`, `auditLabel.ts` (six labels), `i18n.ts` (`hub.privacy.*`, `hub.legal.*`), `lazyParts.tsx`, `screens/AdvancedSettings.tsx`, tests `person-privacy.test.tsx`, `erase-dialog.test.tsx`, `privacy-settings.test.tsx`,
  `case-hold.test.tsx`, `a11y-privacy.test.tsx`, `audit-label.test.ts`, `api.test.ts`, `lazy-screens.test.tsx`, `size.test.ts`.
- **Behaviour:** the two Person items appear only for the owner (`GET /me` role) and the case items by `can('legal.hold')` or, for release, the owner. Erase opens a dialog that first calls the dry run and shows, in words, what will be removed
  and what stays (`safety` is preselected with "keep what is needed to enforce a ban or hold a report"; `none` says a ban the person is under will stop applying and shows a stronger warning), a required typed word `ERASE`, the receipt shown at the end with
  Download (JSON). The dialog says "not legal advice" and "the kit does not tell the player". Export downloads at once. Hold asks for a code from the closed list.
- **Tests (names):**
  - `the Person items are absent for a moderator and a senior and present for the owner; Simple mode and the page are otherwise unchanged (DOM snapshot)`
  - `erase: the dry run is called on open and its counts are shown in words; the word ERASE is required; keep none shows the stronger warning; the receipt is shown and downloadable; an error keeps the dialog open and the choice`
  - `export: one click downloads the file; a failed audit shows the error and downloads nothing`
  - `Privacy requests panel: find by account id opens the person; an unknown id says so without creating anything; the statement table lists categories with retention in days`
  - `hold: the item shows for legal.hold and the closed codes only (no text field); a held report shows the quiet line and the owner's Release item; a 409 reads in words`
  - `no raw ids, hashes or secrets render; all strings through t(); the audit labels exist for the six actions`
  - `lazy: no privacy or hold code in the main chunk; axe: no violations, light and dark; 360 px no sideways scroll; size.test.ts holds`
- **Run:** `npx vitest run packages/hub-react/test/person-privacy.test.tsx packages/hub-react/test/erase-dialog.test.tsx packages/hub-react/test/privacy-settings.test.tsx packages/hub-react/test/case-hold.test.tsx packages/hub-react/test/a11y-privacy.test.tsx packages/hub-react/test/audit-label.test.ts packages/hub-react/test/lazy-screens.test.tsx packages/hub-react/test/api.test.ts packages/hub-react/test/size.test.ts`

### Task P6: Docs, runbook, wording templates, example, gates
Spec 5, 6, 12. Needs P4; the filter paragraph needs F7.
- **Files:** `docs/privacy-requests.md` (an adopter runbook: who verifies the requester (the adopter), `cw.privacy.find`, export, erase, what the receipt is, the safety remainder and when it ends, holds, the bundle and its
  verification, several processes; templates for a reply to a requester and for a hold note, each headed "not legal advice, not a compliance claim"), `packages/store-sqlite/README.md` (the manual erase step and the `kit_claims` warning
  replaced by `cw.privacy`), `packages/core/README.md` (privacy, legal, events, retention, the `@experimental` list), `packages/http/README.md` (routes, permissions, `bundleSecret`), `packages/hub-react/README.md`,
  `docs/status.md` and `docs/plans/follow-ups.md` (what is parked: a verifier CLI for bundles, trusted timestamps, erase by account list, a batch names scan), the `@experimental` lists, `examples/tiny-chat` (`CW_DEMO_PRIVACY=1`: a demo person
  is exported, erased with a receipt, a report is held and a bundle verified), tests `examples/tiny-chat/privacy.test.ts`, `scripts/readme.test.ts` expectations, the core export snapshot.
- **Tests (names):** `tiny-chat with CW_DEMO_PRIVACY exports a demo person, erases them with the safety remainder and shows the receipt, holds a report past a forced purge and verifies its bundle; without the variable none of it exists`;
  `the runbook and every template say "not legal advice" (a grep test)`; `no doc or README claims compliance or legality (a grep test over the phrases "compliant", "GDPR-compliant", "legally")`; `the readme checks pass`;
  `the browser bundle budget holds`.
- **Run:** `npx vitest run examples/tiny-chat/privacy.test.ts scripts/readme.test.ts scripts/browser-bundle.test.ts`, then `npm run lint` and `npm run typecheck`.

---

## Spec coverage (self-review)
4.1 to F1; 4.4 to F2 (and F4 for the account age); 4.5 and 4.6 to F3; 3, 4.2, 4.3 and 4.7 to F4; 4.7 (storage), 4.8 to F5; 4.9 and 8 (filters) to F6; 4.10 to F7; 4.11 to F8; 5.1 and 5.4 to P1; 5.2 and 5.3 to P2;
6 to P3; 5 and 6 (HTTP) and 8 to P4; hub for 5 and 6 to P5; 12 and the runbook to P6; 9 to the per-task hostile, no-leak and logging tests; 13 to the Global Constraints and tasks F4, F5, P1, P3; 14 to the migration and Step 0.
Rulings: 1 F1; 2 F1; 3 F1, F6; 4 F4, F7; 5 F1, F3; 6 F3; 7 F1, F2; 8 F2; 9 F1, F3; 10 F6, F8; 11 F4; 12 F5; 13 F4, F5; 14 F1; 15 to 19 P1, P2; 20 P3; 21 P4; 22 P3; 23 P2; 24 F5, P1, P3; 25 F4.
Names used across tasks (`ResolvedFilters`, `FilterVerdict`, `FilterHit`, `scanLinks`, `judgeLink`, `compilePhrases`, `fileSystem`, `PRIVACY_REGISTRY`, `ErasureReceipt`, `heldSet`, `canonicalJson`, `EvidenceBundle`, `report.escalated`)
are defined once in the owning task and consumed under the same spelling.
