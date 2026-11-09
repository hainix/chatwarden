# Chatwarden K0 + K1: foundation, core, SQLite store, matcher. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working, tested Chatwarden engine that a Node chat server can call to accept or refuse chat, keep evidence, take reports, apply and enforce sanctions, keep lasting mutes and edit a live term list, with no UI and no AI yet.

**Architecture:**
- An npm-workspaces monorepo with three packages:
  - `@chatwarden/core`: pure domain plus in-memory indexes, no IO except `node:crypto`
  - `@chatwarden/store-sqlite`: the `Store` interface on `node:sqlite`
  - `@chatwarden/matcher`: the term matcher on `obscenity`, plus the live term store
- `createChatwarden()` wires them into the public API (`rooms`, `chat`, `mutes`, `reports`, `doors`,
  `sanctions`, `terms`).
- Moxgate's `server/moderation/*` is the behavioural reference. The code is written fresh, and Moxgate's
  test cases are rewritten as kit tests first.

**Tech Stack:** TypeScript 5.7 (strict, ESM, `erasableSyntaxOnly`), Node ≥ 22.13 (`node:sqlite`), npm
workspaces, vitest, eslint, `obscenity` (matcher only), changesets, GitHub Actions.

**Spec:** `docs/design/2026-11-09-chatwarden-design.md` (sections "The platform boundary", "Storage",
"Profanity starring and test data", "Additions from the industry survey" items 2-3, phases K0 and K1).
The feature contract is `docs/design/2026-11-09-feature-contract-from-moxgate.md`; its parts B and C are
K2, not this plan.

**Reference code** (read-only, on the same machine): `C:\dev\moxgate\server\moderation\` and
`C:\dev\moxgate\server\chatModeration.ts`. Their tests are the case checklist named in each task.
**Never copy a real slur into this repo**: the Moxgate tests import `hateTermsSeed` / `hateTermsCorpus`,
and every such case is rewritten with a synthetic term (Task 6 defines them).

## Global Constraints

- Licence Apache-2.0. Every commit is DCO signed-off (`git commit -s`), with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node `>=22.13`, set in every `package.json` `engines` and in `.nvmrc` (`22.13`).
- ESM only (`"type": "module"`). TS `strict`, `erasableSyntaxOnly: true` (no parameter properties, no enums).
- `@chatwarden/core` imports nothing from `node:` except `node:crypto`, and has no runtime dependencies.
  An eslint `no-restricted-imports` rule enforces this.
- No real slur, hate term or profanity list in the repo. Tests use the synthetic terms from Task 6.
- No identifier (client key, account id, IP, any hash, subject id) appears in a value the API returns for a
  player: refusals and deliveries carry reasons, rule numbers, times and line ids only.
- IP never links two subjects and never delivers a notice. An IP sanction row lasts at most 24 h.
- Every time comes from the injected `Clock` (`now(): number`, epoch ms). No `Date.now()` in package code.
- Exact values (from Moxgate, unchanged):
  - chat length 200
  - rate limit 3 per 5 000 ms per room:seat
  - evidence buffer 100 lines / 900 000 ms per room
  - slur strikes: 3 in 3 600 000 ms → 30 min chat restriction; a repeat within 7 days → 24 h
  - reports: 10 per reporter per 24 h; suspension after 3 bad-faith dismissals within 30 days
  - mutes: 180-day TTL, 500 per viewer
  - matcher: minimum collapsed term length 3
  - hasher: HMAC-SHA256 over `${kind}:${input}`, first 32 hex characters
- Local test runs are always targeted (`npx vitest run <path>` in one package). CI runs the whole kit suite.

## Review Focus

1. **A seat changes hands mid-room.** Evidence lines and report targets must name the person who held the
   seat at that moment, not the current occupant (Task 5, Task 12).
2. **One person, two browsers, linked by signing in.** A sanction must follow them to both. Two people
   behind one household IP must stay separate people (Task 4, Task 8).
3. **Boundary times.** A line exactly 900 000 ms old is still evidence. A sanction whose end equals `now`
   no longer applies (Task 5, Task 8).
4. **Unicode evasion and innocent embeddings.** Zero-width joiners, combining accents, fullwidth letters,
   leetspeak, glued punctuation; and an innocent word containing a term (Scunthorpe-style) must not
   block (Task 6).
5. **The store throws on the chat path.** Chat still delivers or refuses, strikes fall back to memory,
   and nothing throws to the caller (Task 10, Task 11).

---

## File structure

```
package.json                     workspaces, scripts: typecheck, lint, test (CI only)
tsconfig.base.json  .nvmrc  .eslintrc.cjs  .changeset/
LICENSE  README.md  CONTRIBUTING.md  AGENTS.md  .github/workflows/ci.yml  .github/dco.yml
packages/core/src/
  types.ts        Identifiers, Subject, Clock, Hasher, Store, Platform, results
  hasher.ts       makeHasher
  subjects.ts     SubjectIndex (resolve, link, merge, aliases)
  evidence.ts     RoomRoster + EvidenceBuffer
  sanctions.ts    applySanction, revokeSanction, SanctionIndex, refCode
  mutes.ts        MuteService
  strikes.ts      StrikeService
  rateLimit.ts    slidingWindow
  chat.ts         ChatService.accept / visibleTo
  reports.ts      ReportService.submit
  doors.ts        DoorService.check
  retention.ts    purge
  chatwarden.ts   createChatwarden facade
  index.ts
packages/store-sqlite/src/  open.ts  migrations.ts  sqliteStore.ts  index.ts
packages/matcher/src/       normalise.ts  matcher.ts  names.ts  termPack.ts  liveTerms.ts  index.ts
packages/matcher/test/fixtures/syntheticPack.ts
examples/tiny-chat/         server.ts  tiny-chat.test.ts
```

The `Store` interface lives in core (`types.ts`); `store-sqlite` implements it. A test-only
`memoryStore` (`packages/core/test/memoryStore.ts`) lets core tests run without SQLite.

---

### Task 1: Repo scaffold, licences, CI

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.nvmrc`, `.eslintrc.cjs`, `.gitignore`, `.changeset/config.json`,
  `LICENSE`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.github/CODEOWNERS` (`* @hainix`),
  `.github/workflows/ci.yml`, `.github/dco.yml`
- Create: `packages/{core,store-sqlite,matcher}/package.json`, `tsconfig.json`, `src/index.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces:
  - the package names `@chatwarden/core`, `@chatwarden/store-sqlite` and `@chatwarden/matcher` (all
    `0.0.0`, `"private": false`, `publishConfig.access: public`)
  - the root scripts `typecheck` (`tsc -b`), `lint` and `test` (`vitest run`, CI only)

- [ ] **Step 1: Write the failing smoke test** `packages/core/test/smoke.test.ts`: `import { VERSION } from '../src/index.js'`; `expect(VERSION).toBe('0.0.0')`.
- [ ] **Step 2: Run it:** `npx vitest run packages/core/test/smoke.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Scaffold the repo.**
  - Each package exports `VERSION`.
  - `tsconfig.base.json`: strict, `module`/`moduleResolution: NodeNext`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
  - eslint: `no-restricted-imports` in `packages/core` bans every `node:*` except `node:crypto`, plus
    `fs`/`path`/`net`/`http`/`sqlite`.
  - README first line, verbatim:
    > **Chatwarden is open-source chat moderation for games and anyone with a chat. It is not a child-safety
    > tool: for CSAM detection and reporting, use [Coop](https://github.com/roostorg/coop) and
    > [HMA](https://github.com/facebook/ThreatExchange/tree/main/hasher-matcher-actioner).**

    Then: status "pre-release, as-is, no support promise; PRs welcome", and the package list.
  - CONTRIBUTING: DCO sign-off required; no slur data in the repo; tests use synthetic terms; issue first for
    big changes.
  - AGENTS.md: the Global Constraints above as rules, plus the targeted-test command.
  - CI: Node 22.13 and 24; `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] **Step 4: Run it:** `npx vitest run packages/core/test/smoke.test.ts`. Expected: PASS. Also `npm run typecheck` and `npm run lint` exit 0.
- [ ] **Step 5: Commit** `git commit -s -m "chore: scaffold monorepo, licences, CI"`, then push to `origin main`. The CI run must go green.

### Task 2: Core types and the hasher

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/hasher.ts`
- Test: `packages/core/test/hasher.test.ts`

**Interfaces:**
- Produces (in `types.ts`, exported from `index.ts`):
  - `interface Identifiers { clientKey: string | null; accountId: string | null; ipHash: string | null }`: hashed key, raw account id, hashed IP
  - `interface RawWho { clientKey?: string; accountId?: string; ip?: string | null }`
  - `type SubjectId = string` (prefix `s_`, 22 base64url characters after it)
  - `interface Clock { now(): number }`
  - `interface Hasher { clientKey(raw: string): string; ip(raw: string): string }`
  - `function makeHasher(secret: string): Hasher`
  - `function hashWho(h: Hasher, who: RawWho): Identifiers`: an empty or missing value → null. The IP
    `'unknown'` → null. The account id is never hashed.

- [ ] **Step 1: Write the failing tests** in `hasher.test.ts`:
  - `byte-compatible with Moxgate`:
    `makeHasher('cw-test-secret').clientKey('tok-1') === '3479e956cc5f4a6bf787a7d5e48d2924'` and
    `.ip('203.0.113.7') === 'e46dc4c1d8ae7679e5a5871123cb155e'`. Internally the kind strings are `'playerKey'`
    and `'ipHash'`, Moxgate's, for compatibility.
  - `empty secret throws`
  - `kinds never collide`: `clientKey('x') !== ip('x')`
  - `hashWho drops empty, missing and 'unknown'`
  - `hashWho keeps a raw account id`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/hasher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `makeHasher` and `hashWho` in `hasher.ts`, and the types in `types.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): identifiers, hasher byte-compatible with Moxgate`.

### Task 3: SQLite store foundation

**Files:**
- Create: `packages/store-sqlite/src/{open.ts,migrations.ts,sqliteStore.ts,index.ts}`
- Modify: `packages/core/src/types.ts` (add the `Store` interface, whose methods later tasks extend)
- Test: `packages/store-sqlite/test/open.test.ts`

**Interfaces:**
- Produces:
  - `function openStore(opts: { path: string } | { db: DatabaseSync }): SqliteStore`
  - `SqliteStore implements Store`
  - `store.schemaVersion(): number`
  - Migrations are an ordered array `{ version: number; sql: string }[]`. They are applied inside one
    transaction each and recorded in `kit_meta(key TEXT PRIMARY KEY, value TEXT)` as `schema_version`.
  - All tables are prefixed `kit_`.
  - `Store` methods are async (`Promise`) per the design. The hot path never awaits them: later tasks keep
    in-memory indexes.

- [ ] **Step 1: Write failing tests:**
  - `fresh file migrates to latest`
  - `reopen is idempotent` (same version, no error)
  - `host DB: an existing meta table and a schema_version row in it are untouched`. Create
    `meta(key,value)` with `schema_version=37` first, open with `{ db }`, then assert `meta` still says 37
    and `kit_meta` says the kit's version.
  - `a failing migration rolls back and leaves the version unchanged`
- [ ] **Step 2: Run** `npx vitest run packages/store-sqlite/test/open.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:sqlite` `DatabaseSync`. Pragmas: `foreign_keys=ON`; `journal_mode=WAL`
  for the path variant only (a host DB keeps its own).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(store-sqlite): open, kit_meta versioned migrations`.

### Task 4: Subjects (one person across browsers and accounts)

**Files:**
- Create: `packages/core/src/subjects.ts`, `packages/core/test/memoryStore.ts`
- Modify: `packages/store-sqlite/src/{migrations.ts,sqliteStore.ts}` (migration 1: `kit_subjects`, `kit_subject_ids`)
- Test: `packages/core/test/subjects.test.ts`, `packages/store-sqlite/test/subjects.store.test.ts`

**Interfaces:**
- Produces:
  - `class SubjectIndex { constructor(store: Store, clock: Clock); load(): Promise<void>; resolve(ids: Identifiers): SubjectId | null; canonical(id: SubjectId): SubjectId; identifiersOf(id: SubjectId): { accounts: string[]; keys: string[]; ips: string[] } }`
  - `resolve` is synchronous: an in-memory map, with the write queued to the store.
  - Rules:
    - a key or an account finds or creates a subject
    - a key and an account seen together are linked; when they belong to two subjects, those subjects merge:
      the older `created_at` survives and the other gets `merged_into`
    - IP only: `resolve` returns null and creates nothing
    - an IP is recorded as seen on the subject but never used to find or merge one
- Store additions: `saveSubject`, `saveIdentifier`, `markMerged`, `loadSubjects(): Promise<{ subjects; ids }>`.

- [ ] **Step 1: Write failing tests** (core, on `memoryStore`):
  - `key alone creates a subject`
  - `same key resolves to the same subject`
  - `key then key+account links`
  - `two subjects merge when an account ties them; the older survives; canonical(alias) is the survivor`
  - `IP alone resolves null`
  - `two keys sharing an IP stay two subjects`
  - `identifiersOf lists every identifier, ips included`
  - `subject ids match /^s_[A-Za-z0-9_-]{22}$/ and are not derived from any identifier`: two indexes fed
    the same identifiers produce different ids
  - Store test: `reload after merge restores aliases`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/subjects.test.ts packages/store-sqlite/test/subjects.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Ids come from `randomBytes(16).toString('base64url')`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): subjects with linking and merge, IP never links`.

### Task 5: Room roster and evidence buffer

**Files:**
- Create: `packages/core/src/evidence.ts`
- Test: `packages/core/test/evidence.test.ts`

**Interfaces:**
- Produces:
  - `interface EvidenceLine { lineId: string; ts: number; seatId: string; handle: string; subject: SubjectId | null; raw: string; delivered: string | null; blocked: boolean; audience: string[] | null }`. `audience` null means the whole room.
  - `class RoomRoster { seat(roomId, seatId, subject: SubjectId | null, handle: string, tags?: Record<string,string>): void; unseat(roomId, seatId): void; occupant(roomId, seatId): { subject: SubjectId | null; handle: string } | null; tags(roomId): Record<string,string>; close(roomId): void }`
  - `class EvidenceBuffer { constructor(opts: { maxLines: 100; maxAgeMs: 900_000; clock: Clock }); append(roomId, line: Omit<EvidenceLine,'lineId'>): string; get(roomId, lineId): EvidenceLine | undefined; snapshot(roomId): EvidenceLine[]; drop(roomId): void }`
  - Line ids are a per-room counter (`"1"`, `"2"`, ...) that never repeats until `drop`. Lines are copied in
    and out.
- Case checklist: every case in Moxgate's `chatBuffer.test.ts`.

- [ ] **Step 1: Write failing tests:** the ported `chatBuffer.test.ts` cases, plus:
  - `exactly maxAgeMs old is kept; one ms older is pruned`
  - `count cap enforced on append`
  - `mutating a returned line does not change the buffer`
  - `a seat that changes hands: lines keep the subject that wrote them` (seat A→subject1, line, unseat, seat
    A→subject2, line; snapshot subjects are [subject1, subject2])
  - `close drops roster and buffer`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/evidence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pruning happens on read; the count cap is applied on write.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): room roster and evidence buffer`.

### Task 6: The matcher

**Files:**
- Create: `packages/matcher/src/{normalise.ts,matcher.ts,names.ts,index.ts}`, `packages/matcher/test/fixtures/syntheticPack.ts`
- Test: `packages/matcher/test/matcher.test.ts`, `packages/matcher/test/names.test.ts`

**Interfaces:**
- Produces:
  - `interface TermRow { id: string; term: string; language: string; active: boolean }`
  - `interface ExceptionRow { id: string; phrase: string; language: string; active: boolean }`
  - `interface Matcher { match(text: string): { termId: string } | null }`
  - `class MatcherBuildError extends Error { readonly rowId?: string }`
  - `function buildMatcher(terms: readonly TermRow[], exceptions: readonly ExceptionRow[]): Matcher`
  - `stripInvisible(text)`, `foldTerm(term)`, `foldPhrase(phrase)`, `collapseLikePreset(word)`
  - `nameViews(name): string[]`, `matchName(m: Matcher, name): { termId } | null`
  - Behaviour is identical to Moxgate's `slurMatcher.ts` and `nameCheck.ts`:
    - NFKD, then strip `\p{M}`, `\p{Cf}` and the blank fillers
    - collapse repeats like obscenity's preset (keep two of b/e/o/l/s/g)
    - plain letters only, collapsed length ≥ 3
    - a whole-word pattern `|word|`
    - a second pass with `! | ( / $ @` turned into spaces
    - word-bounded exceptions matched on the original text
    - all terms inactive → a matcher that never matches
- Synthetic terms (`syntheticPack.ts`): invented words chosen to exercise each mechanism. They are not real
  words in en/es/pt:
  - `zorbak` (plain)
  - `vlemmo` (a double `m` that collapses)
  - `quissel` (a double `s` that is kept)
  - `drakkuun` (a double `k` that collapses; the `uu` collapses too)
  - `fenrisk` (for leetspeak `f3nr1sk`)
  - `tarvo`, with the exception phrase `tarvo lake`, to test exception bounding: `tarvo lakes` and `atarvo lake`
    still block
  - `snerp`, embedded innocently: `snerpington` must not block (whole-word)
  - each with `positive` (must block) and `negative` (must never block) lines
- Case checklist: every case in Moxgate's `slurMatcher.test.ts` and `nameCheck.test.ts`, with each real term
  replaced by the synthetic term with the same shape.

- [ ] **Step 1: Write failing tests:** the ported cases, plus Review Focus 4:
  - `zero-width joiner inside a term blocks` (`zor\u200Dbak`)
  - `combining accents block` (`zórbák`)
  - `fullwidth letters block` (`ｚｏｒｂａｋ`, via NFKD)
  - `glued punctuation blocks` (`zorbak!`, `(zorbak)`)
  - `innocent embedding passes` (`snerpington`)
  - `spaced letters do NOT block (documented residual)` (`z o r b a k` → null)
  - `malformed term throws MatcherBuildError naming the row` (`zo rbak`, `kkk` collapsing below 3)
  - names: `camelCase, underscores and digit runs are views` (`xZorbakx` → null by the whole-word rule;
    `Zorbak_99` blocks)
- [ ] **Step 2: Run** `npx vitest run packages/matcher/test`. Expected: FAIL.
- [ ] **Step 3: Implement**, reading Moxgate's `slurMatcher.ts` and `nameCheck.ts` for behaviour. Write fresh,
  and keep their comments' reasoning where it explains a rule.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(matcher): precision-first whole-word matcher with evasion handling`.

### Task 7: Term packs and the live term store

**Files:**
- Create: `packages/matcher/src/{termPack.ts,liveTerms.ts}`
- Modify: `packages/store-sqlite/src/{migrations.ts,sqliteStore.ts}` (migration 2: `kit_terms`, `kit_term_exceptions`, `kit_audit`)
- Test: `packages/matcher/test/liveTerms.test.ts`, `packages/store-sqlite/test/terms.store.test.ts`

**Interfaces:**
- Produces:
  - `interface TermPack { id: string; version: string; terms: (TermRow & { positive: string[]; negative: string[] })[]; exceptions: ExceptionRow[]; negativeCorpus: string[]; knownLosses: string[] }`
  - `function loadTermPack(json: unknown): TermPack`: validates and throws on bad shape. Fetching and
    signatures are K7.
  - `class LiveTerms implements Matcher { constructor(opts: { store: TermStore; pack: TermPack | null; clock: Clock }); load(): Promise<void>; match(text); readonly rows; readonly usingPack: boolean }`
  - `liveTerms.check(term, language, recentLines: string[]): { ok: true; hits: string[] } | { ok: false; error: string }`:
    what the candidate would block among `negativeCorpus ∪ recentLines`, minus `knownLosses`
  - `liveTerms.change(actor, fn): Promise<{ ok: true } | { ok: false; error: string }>`: the write and reload
    are atomic. It refuses when:
    - no active term would remain
    - a term is malformed
    - an exception would unblock any pack `positive` line that the terms alone block
  - `add/update/setActive` for terms and exceptions, each writing a `kit_audit` row
    `{ at, actor, action, subject_type: 'term'|'exception', before_json, after_json }`
  - Fail-open: a store load failure falls back to the pack. With no pack, the matcher never matches and
    `usingPack` is false. This is logged, never thrown.
  - `TermStore` is the subset of `Store` for terms.
- Case checklist: Moxgate `termsStore.test.ts`, synthetic.

- [ ] **Step 1: Write failing tests:**
  - `seeds from the pack once, then the store rules`
  - `check reports negative-corpus hits and ignores known losses`
  - `change refuses removing the last active term and leaves rows unchanged`
  - `exception canary refuses an exception that unblocks a positive line`
  - `duplicate term (same folded form) refused`
  - `audit row per change`
  - `store failure on load falls back to pack`
  - `no pack and empty store: matches nothing, never throws`
- [ ] **Step 2: Run** `npx vitest run packages/matcher/test/liveTerms.test.ts packages/store-sqlite/test/terms.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Atomicity: the SQLite store exposes `transaction(fn)` using SAVEPOINT, as
  Moxgate's `applyTermChange` does. After any failure, reload to resync.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(matcher): term packs, live term store with negative-corpus gate and audit`.

### Task 8: Sanctions

**Files:**
- Create: `packages/core/src/sanctions.ts`
- Modify: store (migration 3: `kit_sanctions`)
- Test: `packages/core/test/sanctions.test.ts`, `packages/store-sqlite/test/sanctions.store.test.ts`

**Interfaces:**
- Produces:
  - `type SanctionKind = 'chat' | 'area' | 'ban'`. `area` is Moxgate's open-table ban, renamed: "public
    areas" (public rooms, matchmaking). K2 adds `'warning'`.
  - `type Source = 'moderator' | 'auto_filter' | 'coop' | 'api' | 'ai'`
  - `interface SanctionInput { kind; subject: SubjectId; includeIp: boolean; durationMs: number | null; reason: string; actor: string; source: Source; automated: boolean; rule?: string }`
  - `applySanction(store, subjects, input, now): Promise<{ groupId: string; refCode: string }>`
    - writes one row for the subject, plus one row per known IP of the subject when `includeIp` (ends at
      `min(end, now + 24h)`)
    - `pending = 1` when the kill switch is off at write time
    - throws on a non-finite or ≤ 0 duration
  - `revokeSanction(store, groupId, actor, now, reason)`: the first revoke wins
  - `refCode()`: `M-` plus 5 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, unique (retry on collision)
  - `class SanctionIndex { constructor(opts: { enabled: () => boolean }); load(store, now): Promise<void>; active(kind, ids: Identifiers, subject: SubjectId | null, now): { until: number | null; automated: boolean; groupId: string; refCode: string } | null }`
    - matches by canonical subject, or by `ipHash` for IP rows
    - permanent beats timed, otherwise the later end wins
    - judged at query time: `ends_at <= now` is inactive
    - `enabled() === false` → null
- Case checklist: Moxgate `sanctions.test.ts`.

- [ ] **Step 1: Write failing tests:** the ported cases, plus:
  - `sanction follows a merged subject` (sanction s1; merge s2 into s1 via account; a key of s2 is refused)
  - `household IP: a sanction without includeIp never refuses a different subject on the same IP`
  - `IP row capped at 24 h even for permanent`
  - `ends exactly now → inactive`
  - `pending recorded while disabled, becomes active when enabled`
  - `refCode format and uniqueness over 10 000 draws`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/sanctions.test.ts packages/store-sqlite/test/sanctions.store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): sanctions with groups, subjects, IP cap, provenance, ref codes`.

### Task 9: Lasting mutes

**Files:**
- Create: `packages/core/src/mutes.ts`
- Modify: store (migration 4: `kit_mutes`)
- Test: `packages/core/test/mutes.test.ts`

**Interfaces:**
- Produces: `class MuteService { constructor(store, clock); load(): Promise<void>; set(viewer: SubjectId, target: SubjectId, on: boolean): void; isMuted(viewer: SubjectId | null, target: SubjectId | null): boolean; mutedSeats(roomId: string, viewerSeat: string, roster: RoomRoster): string[] }`
  - Mutes are by canonical subject: never by IP, never self.
  - TTL 180 days. Per-viewer cap 500 (the oldest is dropped).
  - The in-memory index is written through to the store.
- Case checklist: Moxgate `mutes.test.ts`.

- [ ] **Step 1: Write failing tests:** the ported cases, plus `mute survives a target's merge`, `expired mute ignored`, `cap drops oldest`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/mutes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): lasting mutes by subject`.

### Task 10: Strikes and automatic timeouts

**Files:**
- Create: `packages/core/src/strikes.ts`
- Modify: store (migration 5: `kit_strikes`)
- Test: `packages/core/test/strikes.test.ts`

**Interfaces:**
- Produces: `class StrikeService { constructor(store, clock); record(subject: SubjectId | null, rateKey: string, roomId: string, termId: string, rawLine: string): { autoRestrict: null | { durationMs: number } } }`
  - `record` is synchronous. It is backed by an in-memory tally per subject, with the store written async.
    When the subject is null or the store write fails, it falls back to a memory tally keyed by `rateKey`.
  - Values as Global Constraints: 3 in 1 h → 30 min; a repeat within 7 days → 24 h.
  - Strikes are consumed by the restriction they trigger.
  - `rawLine` is stored for K2's auto-timeout notice. It is the line the subject typed themselves.
- Case checklist: Moxgate `strikes.test.ts`.

- [ ] **Step 1: Write failing tests:** the ported cases, plus Review Focus 5: `store write throws → still returns a decision from memory, never throws`.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/strikes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): slur strikes and automatic chat timeouts`.

### Task 11: Chat acceptance

**Files:**
- Create: `packages/core/src/{rateLimit.ts,chat.ts}`
- Test: `packages/core/test/chat.test.ts`

**Interfaces:**
- Consumes:
  - `RoomRoster`, `EvidenceBuffer` (Task 5)
  - `Matcher` (Task 6, injected as an interface, so core does not import the matcher package)
  - `SanctionIndex` and `applySanction` (Task 8)
  - `MuteService` (Task 9)
  - `StrikeService` (Task 10)
- Produces:
  - `interface Starrer { star(text: string): string }`: optional profanity starring, injected. The default is
    none.
  - `class ChatService { accept(roomId: string, seatId: string, text: string, opts?: { audience?: string[] }): ChatResult; visibleTo(roomId: string, viewerSeat: string, senderSeat: string): boolean }`
  - `type ChatResult = { deliver: { lineId: string; text: string } } | { refuse: { reason: 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked'; until?: number | null; byModerator?: boolean } }`
    - `'empty'` means the caller should stay silent.
    - K2 adds `rule` and `noticeId` to refusals.
  - The order is Moxgate's `handleChat` order:
    1. trim; empty
    2. gate hook (`gate?: (roomId, subject) => boolean`)
    3. active restriction: chat, or ban, or the in-memory auto restriction; `byModerator` is true for a ban or a
       non-automated row
    4. length > 200
    5. rate 3 per 5 s per `roomId:seatId`, spent even when the line is then blocked
    6. matcher: a hit buffers a blocked line, records a strike (applying an auto timeout with
       `source: 'auto_filter'`), and refuses `'blocked'`
    7. starring
    8. buffer the delivered line → `lineId`
  - It never throws: store errors are swallowed on this path.
- Case checklist: Moxgate `chatPipeline.test.ts` and `server/chatModeration.test.ts` (non-profanity cases;
  starring is tested here with a stub `Starrer`).

- [ ] **Step 1: Write failing tests:** the ported cases, plus:
  - `blocked line is buffered with blocked=true and raw text`
  - `rate budget spent by a blocked line`
  - `third blocked line within an hour restricts chat 30 min`
  - `restricted refusal reports until and byModerator`
  - `visibleTo hides a muted sender from that viewer only, never from the sender`
  - `store throws on strike write → refusal still returned`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): chat acceptance pipeline`.

### Task 12: Report intake

**Files:**
- Create: `packages/core/src/reports.ts`
- Modify: store (migration 6: `kit_reports` with `UNIQUE(reporter_subject, target_subject, room_id)`, plus `status`, `bad_faith`, `actioned_at` columns used by K2)
- Test: `packages/core/test/reports.test.ts`

**Interfaces:**
- Produces:
  - `class ReportService { submit(input: { roomId: string; reporterSeat: string; targetSeat: string; category: 'harassment' | 'hate' | 'cheating' | 'spam' | 'disruption' | 'other'; note?: string; lineId?: string }): Promise<{ ok: true; reportId: string; remaining: number } | { ok: false; refused: 'off' | 'not_player' | 'self' | 'suspended' | 'rate' | 'duplicate'; remaining?: number }> }`
  - The refusal order is Moxgate's: off, not_player, self, suspended, rate, duplicate.
  - The target is the author of `lineId` when it is given and present in the buffer, otherwise the seat's
    current occupant.
  - The excerpt is the buffer snapshot. Each line stores `p` = the index of its writer in the report's `people`
    list (distinct canonical subjects, first-seen order) and no other identity.
  - `note` is trimmed and capped at 500.
  - `remaining` = 10 minus the reports in the last 24 h.
  - Hook: `onReport?(report, counts: { reports7d; rooms7d; auto7d })`. Fenced: a throw never reaches the reporter.
- Case checklist: Moxgate `reports.test.ts` (`handleReport` cases).

- [ ] **Step 1: Write failing tests:** the ported cases, plus:
  - `report against a seat with no chat line stores an empty-excerpt report`
  - `seat changed hands: lineId picks the line's author, not the current occupant`
  - `p indexes map lines to people; no identifiers inside excerpt lines`
  - `remaining counts down and rate refuses at 0`
  - `three bad-faith dismissals in 30 days suspend`. Set the rows directly; dismissing is K2.
  - `onReport throw is swallowed`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/reports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): report intake with server-witnessed evidence`.

### Task 13: Doors and retention

**Files:**
- Create: `packages/core/src/{doors.ts,retention.ts}`
- Test: `packages/core/test/doors.test.ts`, `packages/core/test/retention.test.ts`

**Interfaces:**
- Produces:
  - `class DoorService { check(kind: 'join' | 'create' | 'public' | 'matchmaking', who: RawWho): null | { kind: 'ban' | 'area'; until: number | null; refCode: string } }`
    - `join`/`create` refuse a ban only
    - `public`/`matchmaking` refuse an area ban or a ban, the longest winning
  - `purge(store, now, policy = { reportsMs: 90 days, sanctionAfterEndMs: 90 days, strikesMs: 30 days })`
    - permanent sanctions are kept until revoked, then purged 90 days after the revoke
    - the purge is a store call, not on any hot path
- Case checklist: Moxgate `enforcement.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - the ported door cases, plus `a ban seen by IP alone refuses within its 24 h`
  - retention: `old report purged`, `ended sanction kept until +90 d`, `permanent kept until revoked +90 d`
- [ ] **Step 2: Run** `npx vitest run packages/core/test/doors.test.ts packages/core/test/retention.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): door checks and retention purge`.

### Task 14: `createChatwarden` facade and the tiny-chat example

**Files:**
- Create: `packages/core/src/chatwarden.ts`, `examples/tiny-chat/{package.json,server.ts,tiny-chat.test.ts}`
- Modify: `packages/core/src/index.ts` (public exports only: the facade, types, `makeHasher`)
- Test: `examples/tiny-chat/tiny-chat.test.ts`

**Interfaces:**
- Produces:
  - `createChatwarden(opts: { store: Store; secret: string; platform: Platform; matcher?: Matcher; starrer?: Starrer; clock?: Clock; enabled?: () => boolean; gate?: (roomId: string, subject: SubjectId | null) => boolean }): Promise<Chatwarden>`
  - It loads every index and returns `{ rooms, chat, mutes, reports, doors, sanctions: { apply, revoke }, terms?: LiveTerms, purge }`.
  - `platform.identify(ctx)` is called by `rooms.seat`'s convenience overload `rooms.seatConnection(roomId, seatId, ctx, handle)`.
  - The example is an Express + `ws` server of about 150 lines: one room, `seat` on connect, `chat.accept` on
    message, broadcast honouring `visibleTo`, and `POST /report`. It uses `openStore({ path: ':memory:' })`
    and the synthetic pack.

- [ ] **Step 1: Write the failing integration test** `tiny-chat.test.ts`. Start the server on port 0 and
  connect two `ws` clients A and B, then:
  - `A says hello → B receives it with a lineId`
  - `A sends "zorbak" → A gets refuse blocked, B receives nothing`
  - `B reports A on that line → 200, report stored, excerpt has the blocked line with blocked=true`
  - `apply a 'chat' sanction to A's subject → A's next line is refused restricted`
  - `no frame either client receives contains a subject id, key or hash` (regex scan over all frames:
    `/s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/`)
- [ ] **Step 2: Run** `npx vitest run examples/tiny-chat/tiny-chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the facade and the example.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit and push** `feat: createChatwarden facade and tiny-chat example`. CI must be green on `main`.

---

## After this plan

The K2 plan is written next, against these interfaces as built. It covers Community Rules, Warning, the
ladder, notices, reporter feedback, "My record" and rule-number refusals. The design's phase list is the
sequence.
