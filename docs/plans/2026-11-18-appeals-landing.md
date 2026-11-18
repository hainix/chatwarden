# Appeals landing page, delivery hook and appeal feedback (0.2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Test-first, seen red, then green. Targeted test runs only (by file path); never a full suite. One implementer per chunk; one review per two chunks.

**Goal:** a person who is banned or restricted can appeal from a signed, expiring page outside the game; the game is handed the words for an email; and a granted appeal is passed back to whatever caused the sanction (a term, a chat filter, a report decision), so the system that was wrong hears about it and a person decides what to change.

**Architecture:** `@chatwarden/core` gets a signed link (a capability for one notice), capability filing, fixed decision reasons, overturn recording with strike forgiveness, the delivery hook and the words (en, es, pt). Store migration 27 (one, shared by every task here) adds the columns and one table. `@chatwarden/http` serves the no-JS landing page and its JSON on the player routes, adds the service-mode routes and a signed delivery webhook, and wires `chatwarden serve`. The hub, player-react (`AppealPage`) and the Discord feed follow. Everything is additive on the published 0.2.0.

**Tech Stack:** TypeScript (ESM, Node >= 22.13), vitest, `node:sqlite`, React 18/19, no new runtime dependency.

**Spec:** `docs/design/2026-11-18-appeals-landing-and-feedback.md`, including section 10 (the builder-check rulings, which override earlier sections). Also in force: `docs/design/2026-11-12-appeals-and-names.md` (filing and deciding, unchanged), `AGENTS.md`, `RELEASING.md`. Section numbers below refer to the spec.

## Global Constraints

- **Additive on published 0.2.0.** No breaking change to any public type, route or store contract: new fields and methods are optional. A kit that sets none of the new options behaves exactly as 0.2.0.
- **One migration, 27** (the first after 26, one-way). Every task that needs schema appends a labelled block to it; nobody adds a 28. Both stores (memory and SQLite) agree through the shared contract suite in `test/contract/`.
- **The token (3.1):** `<landingUrl>?t=<token>`, `token = base64url(payload) + '.' + base64url(HMAC-SHA256(secret, 'chatwarden.appeal.v1.' + payload))`, `payload = { v: 1, n: noticeId, e: expiresAtMs }`, no subject id, no personal data, key = the kit's `secret`, constant-time comparison. A token whose notice is gone answers the same "this link is no longer valid" as an expired or forged one.
- **Lifetime (3.2):** `appeals.linkTtlMs` default 30 days, allowed 1 hour to 365 days, never longer than the sanction stays appealable (the 0.1.9 rule). The door refusal mints a fresh link on every refusal.
- **The page (3.3, 3.4):** routes `GET /appeal`, `GET /appeal/case`, `POST /appeal/case`; no `identify` call, no cookie. Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, a strict CSP (no third-party anything), `X-Frame-Options: DENY`. Server-rendered HTML, one inline stylesheet honouring `prefers-color-scheme`, readable at 360 px, no JavaScript needed, a plain form that POSTs, answered with a redirect (POST-redirect-GET). Language: `?lang=`, then `Accept-Language`, then English.
- **Filing (4.2, 10.4):** statement up to 1000 characters, refused rather than cut, rate limited per person per week (`perPlayerPerWeek`); the checks run in the order of `file`. The routes call only `caseByLink` and `fileByLink`.
- **Fixed reasons (5.2):** `upheld`: `rule_applies`, `evidence_clear`, `context_considered`. `reduced`: `first_offence`, `lighter_fits`, `context_considered`. `revoked`: `mistake`, `not_a_violation`, `context_considered`. A reason of the wrong outcome is `invalid_reason`. A missing code is stored as `context_considered` (10.9). The private free-text `reason` stays required and never shown to the person.
- **Overturned (3.7):** a granted appeal (lighter or lifted) and nothing else. Windows: 30 days for reporter accuracy, 90 for term flags and filter counts. `cw.terms.reviewFlags({ days = 90, min = 2 })` returns `{ termId, overturned, lastAt }[]`. Nothing changes a term, a filter or an AI setting automatically.
- **Delivery (3.5, 10.1, 10.2):** `notices.deliver(delivery)` is called after the commit, fenced (a throw or rejection is logged by class and never fails the sanction), once per notice, only when an `accountId` is known (`to: { accountId: string }`, never an IP hash); otherwise `chatwarden.delivery_skipped_no_account` is counted. `NoticeDelivery.sanction` carries `kind`, `until`, `rule`, `source` and `automated`. A reduce sends one email, not two.
- **Service mode (6.5):** `POST /v1/appeals/link`, `POST /v1/appeals`, `POST /v1/appeals/mine`; `appealUrl` on door and notice answers. Delivery: `CHATWARDEN_DELIVERY_URL`, `X-Chatwarden-Signature: sha256=<hmac>` over the body keyed by a separate `CHATWARDEN_DELIVERY_SECRET`, retried in memory 3 times over 10 minutes, logged by class and never with the body.
- **Privacy:** every new person-keyed table or column is in `PRIVACY_REGISTRY` and covered by `exportSubjects` / `eraseSubjects` in BOTH stores (`kit_overturns` is new). Logs name a class, never an id, token, URL or body. The token and the link are never logged.
- **Standing rules:** the AI seam (`ai/**` import allowlist, narrowed AI store, source `'ai'` refused) is not loosened. Synthetic terms only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn). Non-ASCII only as `\u` escapes. LF endings. Browser-bundled code and shipped strings contain no bare word `process` or `require` (`scripts/browser-bundle.test.ts`). Hub: UI clean core, power behind one advanced door, off by default. `node:sqlite` binds exactly as many values as the SQL has `?`, and each new SQL constant goes in `packages/store-sqlite/test/sql-placeholders.test.ts`.
- **Peer floors (RELEASING.md "When a peer floor must rise"):** http, discord, hub-react and player-react use new core API, so their `@chatwarden/core` peer becomes `^0.2.1`; hub-react's `@chatwarden/http` peer and hub-element's `@chatwarden/hub-react` peer become `^0.2.1`; the two stores stay `^0.2.0`. Done in task A14, with `scripts/manifests.test.ts` changed in the same commit.

## Plan rulings (the spec was silent or its sections disagreed; the briefs follow these)

1. **MAC input.** The MAC covers the base64url payload segment exactly as sent (no re-serialisation); the signature segment is base64url of the 32 MAC bytes; the MAC is checked before the payload is parsed.
2. **Settings home.** `appeals.landingUrl` and `appeals.landingOrigins` are `createChatwarden` options (`ChatwardenOptions.appeals`, code or env only). `linkTtlMs`, `contact`, `emailsOutcome` and `words` are profile `appeals` fields (live). `words` is a per-language map `{ [language]: { [wordKey]: string } }`, set through the profile, with no hub editor in 0.2.1. `cw.appeals.landingOrigins()` is the one accessor http reads, so the two cannot disagree.
3. **Strike overturn rows.** 10.6 supersedes the strikes index of section 7: term flags and filter counts read `kit_overturns`, so migration 27 indexes `kit_overturns`, not `kit_strikes`. `kit_overturns.source` is the sanction's `Source`.
4. **Delivery sites.** `cw.sanctions.apply` writes no notice (`decide` is the only path), and `decide.ts` creates its notices with `notify: false` and announces after the commit, so 10.2's "created with notify: true" does not describe the code. Delivery fires at the three real creation sites: a decision's committed group notices (moderator, coop, api, ai: all go through `decide`), the automatic restriction's notice in `chat.ts`, and an appeal outcome. A replayed decision delivers nothing.
5. **A decided notice stays viewable.** Reducing or revoking withdraws the notice, which would kill the link before the person can read the outcome. A link stays valid, read-only, when its notice is withdrawn and the notice's group has an appeal in `upheld`, `reduced` or `revoked`. A moot appeal, an erased or purged notice, and any other withdrawal answer "invalid".
6. **Delivery contents.** An `appeal_outcome` carries `sanction` as it stands after the decision (the replacement for a reduce; the original, with `outcome.status: 'revoked'`, for a revoke; the original for an uphold). Emails carry no excerpt lines, and times are written in UTC. The no-account skip is logged at most once a minute with a count.
7. **Nothing to link for the AI.** Acting is shadow-only in 0.2.0: no sanction with source `'ai'` is written, so 10.8's linking has nothing to link. A test pins that a sanction row of source `'ai'` with a `reportId` runs 6.3.
8. **`cause.term.strikes`** is the configured strike count (`limits.strikes.count`). **Reporter count:** an overturned report is left out of `decided` as well as `actioned`; `ReporterAccuracy.overturned` counts them.
9. **Words live in core.** The served page and the email cannot import player-react's catalogues, so core gets the subpath `@chatwarden/core/notice-locales` (English page, reason and delivery words, plus es and pt for every notice, reason, page and delivery word). player-react's own es/pt keep their copies of the notice keys; a parity test fails if they drift.
10. **Landing limits and shape.** Reads: 60 per hour per IP. Writes: 10 per hour per IP and per token (the player-route default). A bad link of any cause is a 404 with the same body. The form posts to `POST /appeal/case` (urlencoded), answered `303` to the relative `../appeal?t=...&e=<code>`.
11. **Serve env.** `CHATWARDEN_PUBLIC_URL` (landing URL = it + `/appeal`), `CHATWARDEN_LANDING_ORIGINS` (comma list), `CHATWARDEN_DELIVERY_URL`, `CHATWARDEN_DELIVERY_SECRET` (32 or more characters; both delivery variables or neither). Retries wait 1, 3 and 6 minutes (10 in all).
12. **New facade names.** `cw.terms.reviewFlags`, `cw.filters.overturned`, `cw.appeals.link/openLink/caseByLink/fileByLink/landingOrigins`, `SubjectIndex.latestAccount`.

## Review Focus

The failure modes the spec implies that a person using this would most likely hit. Each has a named test in the task that owns the code.

1. **The token is a capability, not a session** (A5, A8). Forgery: a flipped bit in either segment, a truncated, doubled or empty segment, a payload from one token with the MAC of another, `v` other than 1, a MAC made under another prefix (the bare `hmacSha256Hex(secret, payload)` the holdback hash uses, a webhook-style signature) never verifies. Expiry: `e <= now` is invalid at the boundary. A notice that has gone (erased, purged, withdrawn by a moderator, appeal made moot) answers exactly like a forged or expired link: same status, same body bytes. Timing: the MAC is compared in constant time and checked before the payload is parsed. Namespacing: an appeal token never verifies as any other kit signature and no other signature as an appeal token.
2. **The landing page shows one sanction and nothing else** (A5, A8). No other notice, appeal or person, no staff name or ref, no private reason, no group id, no account or key or IP, no reporter, whatever the data. `AppealCase` and the JSON are allow-listed by key (a snapshot of the keys), the HTML escapes every value (an excerpt line, the contact, a game's own words), the token is the only request value echoed (and only in an attribute after a charset check), the statement is never echoed back, and `?lang=` is mapped to a known language, never reflected.
3. **The no-JS form and CORS** (A8). The form POST answers `303` with no body and the refresh of the result page cannot re-file. A refusal is carried as a whitelisted code in the redirect, never as free text. A urlencoded body over the cap is 413, a wrong content type is 400. `OPTIONS` answers only for an origin listed in `landingOrigins` (exact origin, never `*`, never `null`); an unlisted origin gets no CORS header; `Vary: Origin`; no credentials header; CORS is on `/appeal/case` only, never on the page.
4. **Strike forgiveness** (A3). A granted appeal on an automatic restriction drops the strikes that tipped it and its start, live and after a restart (`load()`): the person's next restriction is computed as if it never happened (a first offence is 30 minutes again, not 24 hours). A later, unrelated strike survives. An earlier restriction's start is restored as the "latest start" when the later one is overturned. A moderator lifting a timeout outside an appeal changes nothing (3.7).
5. **Privacy coverage of `kit_overturns`** (A1). In `PRIVACY_REGISTRY`; in `exportSubjects` and `eraseSubjects` of both stores; the SQLite completeness test fails without it; an erase leaves no row naming the person except for a held group; the retention purge removes it on the appeals clock; the `term_id` kept on a sanction is a term, not a person.
6. **Delivery fires exactly once per path** (A7). A decision with several groups (once per notified person), an automatic restriction, an appeal upheld, reduced and revoked (one email for a reduce, none for its replacement notice), a decision replay (none), a decision that rolls back (none), a note or a report outcome or a rename (none); a throwing hook, a rejecting hook and a hook that is slow never fail the sanction; no `accountId` means no call and a counted skip.
7. **Door refusals and notices carry a working link, or none** (A5, A9). `appealUrl` is absent when appeals are off, `landingUrl` is unset, the notice is not a sanction, or it is no longer appealable; a refusal mints a fresh link each time; a bystander refused through someone else's shared-IP row gets no link.
8. **Decision reasons** (A2, A10). A reason of the wrong outcome is refused (`invalid_reason`) and nothing is written; a missing one is stored as `context_considered`; the hub always sends one; an appeal decided before 0.2.1 (no stored reason) reads as `null`, never an error.

## Chunks and order

| Chunk | Tasks | What it holds | Review |
| --- | --- | --- | --- |
| 1 | A1, A2 | store and migration 27 foundations (overturn storage, privacy; reason column, reasons) | R1 after chunk 2 |
| 2 | A3, A4 | overturn recording, strike forgiveness, the event; causes, review flags, filter counts, reporter count | R1 |
| 3 | A5, A6, A7 | the link and capability filing; words in en, es, pt; the delivery hook | R2 after chunk 4 |
| 4 | A8, A9 | the landing routes and page; service routes, delivery webhook, serve wiring, admin extras | R2 |
| 5 | A10, A11 | the hub; `AppealPage` | R3 after chunk 6 |
| 6 | A12, A13, A14 | Discord feed and events; docs and recipes; release prep | R3 |

Dependencies: A2 needs A1; A3 and A4 need A1 and A2; A5 needs A2; A6 is independent of A3 to A5 but needs A2; A7 needs A5 and A6; A8 needs A5 and A6; A9 needs A5, A7 and A8; A10 needs A2, A4 and A9; A11 needs A5, A6 and A8; A12 needs A3; A13 needs everything before it; A14 is last.

---

## Chunk 1: store foundations

### Task A1: Overturn storage (migration 27 block 1, both stores, privacy, retention)

**Files:**
- Modify: `packages/core/src/types.ts` (`SanctionRow.termId?`, `SanctionRow.overturnedAt?`, `ReporterOutcomeRow.overturned?`, `StoredReport.overturnedAt?`, `OverturnInput`, the six Store methods below)
- Modify: `packages/core/src/privacy.ts` (the `appeals` rule lists `kit_overturns`; export and erase words), `packages/core/src/retention.ts` (purge on `appealsMs`)
- Modify: `packages/core/src/sanctions.ts` (`SanctionInput.termId`, guarded by the same internal key as `reportId`; `writeSanction` sets `termId`)
- Modify: `packages/store-sqlite/src/migrations.ts` (new entry `version: 27`, block 1), `packages/store-sqlite/src/sqliteStore.ts`, `packages/store-sqlite/src/privacy.ts`
- Modify: `packages/store-memory/src/memoryStore.ts` (the changed reads, privacy export and erase), `packages/store-memory/src/memoryAppeals.ts` (the overturn methods ride with `withMemoryAppeals`)
- Create: `test/contract/overturns.contract.ts`; modify `test/contract/index.ts`, `strikes.contract.ts`, `sanctions.contract.ts`, `reports.contract.ts`, `privacy.contract.ts`
- Create: `packages/store-sqlite/test/overturns.migration.test.ts`; modify `sql-placeholders.test.ts`, `filters.migration.test.ts` and `entity.migration.test.ts` (their "no 27" pins), `privacy.registry-complete.test.ts`, `indexes.store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all optional on `Store`, so a store written for 0.2.0 still type-checks):
  - `OverturnInput { groupId: string; at: number; subject: SubjectId; aliases: readonly SubjectId[]; source: Source; termId: string | null; filterKey: string | null; reportId: string | null; strikes: { from: number; to: number } | null }`
  - `recordOverturn?(o: OverturnInput): boolean`, one transaction: insert the `kit_overturns` row (false and nothing else changed when `groupId` already has one), set `kit_sanctions.overturned_at` for the group, set `kit_strikes.overturned = 1` for `aliases` with `from <= at <= to` when `strikes` is given, set `kit_reports.overturned_at` for `reportId`, move the change token.
  - `latestAutoChatStart?(subjects: readonly SubjectId[]): number | null` (latest `starts_at` of an `auto_filter` chat subject row that is not overturned; revoked and ended rows count).
  - `overturnedTermCounts?(since: number): Array<{ termId: string; overturned: number; lastAt: number }>`; `overturnedFilterCounts?(since: number): Array<{ filterKey: string; overturned: number }>`; `purgeOverturns?(before: number): number`.
  - Changed reads: `loadStrikes` leaves out overturned strikes; `loadAutoChatStarts` leaves out overturned groups; `reporterOutcomes` rows carry `overturned` and `actioned` excludes overturned; `insertSanctionGroup` stores `termId`; `loadSanctionSubjectRow` returns `termId` and `overturnedAt` when set.
  - Migration 27 block 1 (SQL in the brief): `kit_sanctions.term_id`, `kit_sanctions.overturned_at`, `kit_strikes.overturned`, `kit_reports.overturned_at`, table `kit_overturns`, its indexes, and the covering `reporterOutcomes` index rebuilt with `overturned_at`.

- [ ] **Step 1: Write the failing tests** (names in the brief): `overturns.contract.ts` (record is atomic and idempotent; strikes in the window only; sanction and report marked; counts by term and by filter with the window; purge), strikes, sanctions and reports contracts for the changed reads, privacy contract (export carries `overturnedAt`, erase deletes the person's overturn rows and keeps a held group's), `overturns.migration.test.ts` (version 26 database upgrades, defaults, old index gone, no 28).
- [ ] **Step 2: Run them red** (commands in the brief).
- [ ] **Step 3: Implement** the types, migration block, SQLite store, memory store, privacy and retention.
- [ ] **Step 4: Run green**, plus `sql-placeholders.test.ts`, the registry-complete test and the migration tests of store-sqlite; `npm run typecheck` and `npm run lint` exit 0.
- [ ] **Step 5: Commit** by pathspec.

### Task A2: Fixed reasons and the reason column

**Files:**
- Modify: `packages/core/src/appeals.ts`, `appealService.ts` (`checkDecision`, `decideChecked`), `events.ts` (`appeal.decided.reason`), `types.ts` (`AppealRow.reasonCode?`, `decideAppeal` patch, `loadNotice?`), `index.ts`, `chatwarden.ts` (docs of `decide`)
- Modify: `packages/store-sqlite/src/migrations.ts` (block 2: `kit_appeals.reason_code`), `sqliteStore.ts`, `privacy.ts` (export), `packages/store-memory/src/memoryAppeals.ts`
- Modify: `packages/http/src/admin/appeals.ts`, `validate.ts` (`bodyAppealDecision` accepts `reasonCode`), `errors.ts` (`invalid_reason`, 400)
- Create: `packages/core/test/appeals-reasons.test.ts`; modify `appeals-decide.test.ts`, `vocabulary-appeals.test.ts`, `test/contract/appeals.contract.ts`, `notices.contract.ts` (`loadNotice`), `packages/http/test/admin.appeals.test.ts`, `admin.appeals-bodies.test.ts`

**Interfaces:**
- Consumes: A1's migration entry (append block 2) and the memory appeal wrapper.
- Produces: `APPEAL_REASON_CODES`, `type AppealReasonCode`, `APPEAL_REASONS: Readonly<Record<AppealOutcome, readonly AppealReasonCode[]>>`, `APPEAL_REASON_DEFAULT = 'context_considered'`; `AppealDecision.reasonCode?: AppealReasonCode`; `AppealDecideResult` error union gains `'invalid_reason'`; `AppealDetail.decided.reasonCode: AppealReasonCode | null`; event `{ type: 'appeal.decided'; ...; reason: AppealReasonCode }`; `Store.loadNotice?(id: string): NoticeRow | null`; `AppealRow.reasonCode?: string | null`; `decideAppeal` patch `reasonCode?: string`; the admin route accepts `reasonCode` and answers 400 `invalid_reason`.

- [ ] **Step 1: Write the failing tests** (`appeals-reasons.test.ts`: every valid outcome and code pair accepted and stored; every cross-pair refused and nothing written; absent stored as `context_considered`; non-string and unknown refused; the event carries `reason`; an appeal decided with no stored reason reads `null`; the route 400 and its pass-through).
- [ ] **Step 2: Run them red.**
- [ ] **Step 3: Implement** the codes, the check in `checkDecision` (after the shape check, before any store read), the store column and methods, the event field, the route.
- [ ] **Step 4: Run green** (core appeals tests, the two store contracts, the http admin appeals tests); typecheck and lint.
- [ ] **Step 5: Commit.**

## Chunk 2: feedback in core

### Task A3: Overturn recording, strike forgiveness, the event

**Files:**
- Modify: `packages/core/src/appealService.ts` (record inside the decision transaction; forgive after the commit; emit), `strikes.ts` (`StrikeService.forgive`), `chat.ts` (pass the tipping term id), `sanctions.ts` (guarded `termId`), `events.ts` (`sanction.overturned`, appended to `KIT_EVENT_TYPES`), `chatwarden.ts` (wire `forgive`, the strike window), `index.ts`
- Create: `packages/core/test/appeals-overturn.test.ts`, `strikes-forgive.test.ts`, `chat-autorestrict-term.test.ts`
- Modify: the tests that pin `KIT_EVENT_TYPES` (`vocabulary-appeals.test.ts`, `vocabulary-desk.test.ts`, `vocabulary-legal.test.ts`, `smoke.test.ts`, `packages/discord/test/feed.digest.test.ts`, `scripts/readme.test.ts`)

**Interfaces:**
- Consumes: A1 (`recordOverturn`, `latestAutoChatStart`, changed reads, `SanctionRow.termId`), A2 (reason on the decision).
- Produces: `StrikeService.forgive(subject: SubjectId, startsAt: number): void`; `AppealServiceDeps.strikeWindowMs: number` and `forgive?: (subject: SubjectId, startsAt: number) => void`; event `{ type: 'sanction.overturned'; groupId: string; at: number; source: Source; termId?: string; filterKey?: string }`; the automatic restriction's sanction row stores `termId`.

- [ ] **Step 1: Write the failing tests** (the strike scenarios of Review Focus 4 with a first offence after forgiveness, live and after a restart; an alias merged person; an earlier start restored; the event once, after commit, never for an uphold, never when the decision rolls back; a moderator revoke outside an appeal records nothing; a failing `forgive` or a store without `recordOverturn` never fails the decision; a `source: 'ai'` row with a `reportId` still runs `onGranted`; the auto-restriction row has the third strike's term id).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** `forgive` (drop the person's and aliases' tally entries with `startsAt - windowMs <= t <= startsAt`, then set `lastAutoStart` to `latestAutoChatStart(aliases)` or delete it), the recording in `decideChecked`, the termId path in `chat.ts`.
- [ ] **Step 4: Run green** (the three new files, `appeals-decide`, `strikes`, `chat` tests the brief names); typecheck, lint.
- [ ] **Step 5: Commit.**

### Task A4: Causes, review flags, filter counts, reporter count

**Files:**
- Modify: `packages/core/src/appeals.ts` (`AppealCause`, `AppealDetail.cause`), `appealService.ts` (`get`), `reporterAccuracy.ts`, `chatwarden.ts` (`cw.terms`, `cw.filters.overturned`), `index.ts`
- Create: `packages/core/test/appeals-cause.test.ts`, `terms-review-flags.test.ts`, `filters-overturned.test.ts`; modify `reporter-accuracy` tests (name in brief)

**Interfaces:**
- Consumes: A1 (`overturnedTermCounts`, `overturnedFilterCounts`, `reporterOutcomes.overturned`, `termId`), A3 (overturn rows exist).
- Produces:
  - `type AppealCause = { source: 'report'; reportId: string; decidedBy: 'human' | 'ai' } | { source: 'term'; termId: string | null; strikes: number } | { source: 'filter'; reportId: string; filterKey: string; decidedBy: 'human' | 'ai' } | { source: 'other'; via: 'coop' | 'api' }` and `AppealDetail.cause: AppealCause`.
  - `cw.terms.reviewFlags(q?: { days?: number; min?: number }): Array<{ termId: string; overturned: number; lastAt: number }>` (days 1..365 default 90, min 1..1000 default 2, `RangeError` otherwise; sorted by `overturned` desc, `lastAt` desc, `termId`).
  - `cw.filters.overturned(q?: { days?: 7 | 30 | 90 }): Record<string, number>` (default 90).
  - `ReporterAccuracy.overturned: number`; `summarizeOutcomes` input gains `overturned?: number`.

- [ ] **Step 1: Write the failing tests** (each cause shape for each source; a null term id for an older row; windows and the `min` edge; a term overturned in two groups counts 2; a filter report decided by a person feeds both the filter count and 6.3; an overturned report is in neither `actioned` nor `decided` and shows in `overturned`; a store without the methods reads empty).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, typecheck, lint.
- [ ] **Step 5: Commit.**

## Chunk 3: the link, the words, the hook

### Task A5: The signed link and capability filing

**Files:**
- Create: `packages/core/src/appealLink.ts`
- Modify: `packages/core/src/appeals.ts` (settings: `linkTtlMs`, `contact`, `emailsOutcome`, `words`; `AppealCase`), `appealService.ts` (`link`, `openLink`, `caseByLink`, `fileByLink`; `file` and `fileByLink` share one body), `notices.ts` (`appealableUntil`, `PlayerNotice.appealUrl?`), `doors.ts` (`DoorRefusal.appealUrl?`), `chatwarden.ts` (`ChatwardenOptions.appeals`, the facade, `notices.pending/record` carry `appealUrl`), `profile.ts` (the appeals section keys), `index.ts`
- Create: `packages/core/test/appeals-link.test.ts`, `appeals-link-case.test.ts`, `appeals-link-file.test.ts`, `appeals-link-settings.test.ts`; modify `doors.test.ts`, `appeals-settings.test.ts`, `policy-layer-appeals.test.ts`

**Interfaces:**
- Consumes: A2 (`loadNotice`, reason in `AppealCase`).
- Produces:
  - `ChatwardenOptions.appeals?: { landingUrl?: string; landingOrigins?: readonly string[] }`.
  - `cw.appeals.link(noticeId: string, opts?: { ttlMs?: number }): string | null`; `openLink(token: string): { ok: true; noticeId: string; expiresAt: number } | { ok: false; reason: 'invalid' }` (signature and expiry only); `caseByLink(token: string): { ok: true; case: AppealCase } | { ok: false; reason: 'invalid' }`; `fileByLink(token: string, input: { statement: string }): AppealFileResult`; `landingOrigins(): readonly string[]`.
  - `AppealCase { notice: { kind: 'warning' | 'chat' | 'area' | 'ban'; rule: RuleRef | null; ruleLabel: string | null; until: number | null; refCode: string | null; createdAt: number; excerpt: Array<{ text: string; day: string }> }; canAppeal: boolean; appeal: { status: 'open' | 'upheld' | 'reduced' | 'revoked'; createdAt: number; decidedAt: number | null; reason: AppealReasonCode | null } | null; standing: { kind: 'warning' | 'chat' | 'area' | 'ban'; until: number | null } | null; expiresAt: number; emailsOutcome: boolean; contact: string | null; statementMax: number }`.
  - `ResolvedAppeals` gains `linkTtlMs: number` (default 2592000000), `contact: string | null`, `emailsOutcome: boolean`, `words: Readonly<Record<string, Readonly<Record<string, string>>>>`.
  - `PlayerNotice.appealUrl?: string`, `DoorRefusal.appealUrl?: string`; `mintAppealToken(secret, noticeId, expiresAt)` and `verifyAppealToken(secret, token, now)` in `appealLink.ts` (not public).

- [ ] **Step 1: Write the failing tests** (Review Focus 1, 2 and 7 at the core level: forgery matrix, boundary expiry, gone notices, decided-notice view, namespacing, the shared filing order and weekly cap per person, the `AppealCase` key allow-list, `link` null cases, TTL cap by the appealable end, door refusal link per refusal, no link without `landingUrl`, settings validation and `landingUrl` and `landingOrigins` checks).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, typecheck, lint.
- [ ] **Step 5: Commit.**

### Task A6: The words in en, es and pt, and the delivery text

**Files:**
- Create: `packages/core/src/appealWords.ts`, `noticeLocales.ts` (the subpath entry), `noticeLocales.es.ts`, `noticeLocales.pt.ts`, `deliveryCopy.ts`
- Modify: `packages/core/src/noticeCopy.ts` (`durationText`), `packages/core/package.json` (exports `./notice-locales` and its `typesVersions`), `index.ts`
- Create: `packages/core/test/notice-locales.test.ts`, `delivery-copy.test.ts`; modify `packages/player-react/test/notice-copy-parity.test.tsx` (es and pt parity)

**Interfaces:**
- Consumes: A2 (`AppealReasonCode`).
- Produces: `@chatwarden/core/notice-locales` exporting `APPEAL_WORDS` (the English words, keys below), `type AppealWordKey`, `NOTICE_WORDS_ES`, `NOTICE_WORDS_PT` (`Readonly<Partial<Record<NoticeWordKey | AppealWordKey, string>>>`), `noticeWordsFor(locale: unknown, overrides?: AppealWordOverrides): { locale: string; words: Record<string, string> }`, `chooseLocale(requested: readonly unknown[], overrides?: AppealWordOverrides): string`; `buildDeliveryContent(o): { subject: string; text: string; html: string }`; `durationText(ms: number, locale: string): string`; `escapeHtml(s: string): string`. Key families: `player.appeal.reason.<outcome>.<code>` (9), `player.appealPage.*`, `delivery.*` (full list with English values in the brief).

- [ ] **Step 1: Write the failing tests** (every key has en, es and pt; placeholders `{when}`, `{length}`, `{max}`, `{contact}` agree across languages; locale choice from a tag list and Accept-Language style input; overrides win and an unknown key in `overrides` is ignored; `durationText` for 30 minutes, 24 hours, 7 days; the email for each kind and language, link present only when `appealUrl` is given; `html` escapes a hostile override word and a hostile URL; no excerpt line in the email; player-react es and pt equal core's for every notice key).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** (es and pt as `\u` escapes; they are machine drafts, like the rest).
- [ ] **Step 4: Run green**, typecheck, lint, and `scripts/browser-bundle.test.ts` (the new subpath has no bare `process` or `require`).
- [ ] **Step 5: Commit.**

### Task A7: The delivery hook

**Files:**
- Create: `packages/core/src/delivery.ts`
- Modify: `packages/core/src/chatwarden.ts` (`ChatwardenOptions.notices`, wiring), `decide.ts` (after-commit call per notified group), `chat.ts` (after the automatic restriction's notice), `appealService.ts` (an outcome delivery), `subjects.ts` (`latestAccount`), `index.ts`
- Create: `packages/core/test/delivery.test.ts`, `delivery-paths.test.ts`, `subjects-latest-account.test.ts`

**Interfaces:**
- Consumes: A5 (`link`, `loadNotice`), A6 (`buildDeliveryContent`, `noticeWordsFor`), A3 (the three creation sites).
- Produces: `ChatwardenOptions.notices?: { deliver?: (d: NoticeDelivery) => void | Promise<void>; localeOf?: (to: { accountId: string }) => string | undefined }`; exported `NoticeDelivery { kind: 'sanction' | 'appeal_outcome'; noticeId: string; to: { accountId: string }; locale: string; subject: string; text: string; html: string; appealUrl: string | null; sanction: { kind: SanctionKind; until: number | null; rule: RuleRef | null; source: Source; automated: boolean }; outcome?: { status: 'upheld' | 'reduced' | 'revoked'; reason: AppealReasonCode } }`; `SubjectIndex.latestAccount(id: SubjectId): string | null`; internal `DeliveryService.sanctionNoticed(noticeId: string): void` and `appealDecided(o): void`.

- [ ] **Step 1: Write the failing tests** (Review Focus 6 path by path with counting hooks; account choice and the no-account skip with the throttled log; locale from `localeOf`, the unknown locale falls back to English; the appeal link is in the text of a sanction and of an upheld outcome and absent for a revoke; the fence for a throw, a rejection and a never-settling promise).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, plus `decide`, `chat` and `appeals-decide` tests; typecheck, lint.
- [ ] **Step 5: Commit.**

## Chunk 4: the http side

### Task A8: The landing routes and page

**Files:**
- Create: `packages/http/src/appealLanding.ts` (routes, CORS, rate limits), `packages/http/src/appealPage.ts` (the template module)
- Modify: `packages/http/src/player.ts` (spread the routes, options), `packages/http/src/index.ts` (exports), `packages/http/src/errors.ts` if a code is missing
- Create: `packages/http/test/appeal-landing.test.ts`, `appeal-landing-leak.test.ts`, `appeal-landing-form.test.ts`, `appeal-landing-cors.test.ts`, `appeal-page.test.ts`; modify `player.test.ts` (route table keys)

**Interfaces:**
- Consumes: A5 (`caseByLink`, `fileByLink`, `landingOrigins`), A6 (`noticeWordsFor`, `chooseLocale`, `escapeHtml`).
- Produces: `appealLandingRoutes(cw: Chatwarden, options?: AppealLandingOptions): RouteTable` with `AppealLandingOptions { logger?: Logger; now?: () => number; readRateLimit?: NamesRateLimit; appealsRateLimit?: NamesRateLimit }`; `APPEAL_PAGE_CSP`; `renderAppealPage(view: AppealPageView): string`; the player routes include the three routes and `OPTIONS /appeal/case`.

- [ ] **Step 1: Write the failing tests** (Review Focus 2 and 3; the five page states in en, es, pt and a game's own words; headers; invalid link identical for forged, expired, gone and a moot appeal; a read after a decision shows the outcome with the fixed reason sentence; per IP and per token limits; no identify call and no `set-cookie`).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**; typecheck, lint, `scripts/browser-bundle.test.ts` and `packages/http/test/ascii-source.test.ts`.
- [ ] **Step 5: Commit.**

### Task A9: Service routes, the delivery webhook, serve, admin extras

**Files:**
- Create: `packages/http/src/service/deliveryWebhook.ts`
- Modify: `packages/http/src/service/routes.ts` (three routes, `appealUrl` on doors and notices), `refusal.ts` (`DoorAnswer.appealUrl`), `client.ts` (`appealLink`, `fileAppeal`, `appeals` methods), `serve.ts` (config, env, wiring, mount), `cli/args.ts` if env lists are checked there, `admin/terms.ts` (`reviewFlags`), `admin/filters.ts` (`overturned`), the reporter accuracy summary copy in `admin/`
- Create: `packages/http/test/service.appeals.test.ts`, `service.delivery.test.ts`, `serve.landing.test.ts`; modify `service.contract.test.ts`, `service.openapi.test.ts`, `service.request-drift.test.ts`, `serve.config.test.ts`, `serve.start.test.ts`, `admin.terms.test.ts`, `admin.filters.test.ts`

**Interfaces:**
- Consumes: A5, A7, A8.
- Produces: `POST /v1/appeals/link` (`{ noticeId }` -> `{ url: string | null }`), `POST /v1/appeals` (`{ who, noticeId, statement }` -> `{ ok: true; appeal } | { ok: false; refused; retryAfterMs? }`), `POST /v1/appeals/mine` (`{ who }` -> `{ appeals }`); `createDeliveryWebhook(o: { url: string; secret: string; fetch?: typeof fetch; setTimeout?: ...; logger?: Logger }): { deliver(d: NoticeDelivery): void; dispose(): void }`; `ServeConfig.publicUrl`, `landingOrigins`, `deliveryUrl`, `deliverySecret`; `GET /terms` body gains `reviewFlags`, `GET /filters/stats` gains `overturned`.

- [ ] **Step 1: Write the failing tests** (route table and OpenAPI agree; the refusal union; the signature header against an independent HMAC; retries at 1, 3, 6 minutes with fake timers and then dropped, never logging the body; startup refusals for a lone delivery variable, a short secret, a bad URL; `serve` answers `/appeal` and sets `landingUrl`).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**; typecheck, lint.
- [ ] **Step 5: Commit.**

## Chunk 5: the screens

### Task A10: The hub

**Files:**
- Modify: `packages/hub-react/src/case/AppealCard.tsx` (reason radio, "What caused this"), `screens/Terms.tsx` (review flag), `filters/FilterHits.tsx` (overturned), `screens/AppealSettings.tsx` and `policy/appeals.ts` (link lifetime, contact, emails outcome), `types.ts`, `client.ts`, `labels.ts`, `i18n.ts`, `locales/es.ts`, `locales/pt.ts`, `styles.css`
- Create: `packages/hub-react/test/appeal-reason.test.tsx`, `appeal-cause.test.tsx`, `terms-review-flag.test.tsx`, `filter-overturned.test.tsx`; modify `appeal-card.test.tsx`, `appeal-settings.test.tsx`, `a11y-appeals.test.tsx`, the locale completeness tests, and the README name lists the readme tests check

**Interfaces:**
- Consumes: A2 (`reasonCode`, route), A4 (`cause`), A9 (`reviewFlags`, `overturned`).
- Produces: `AppealDecisionInput.reasonCode?: AppealReasonCode`; hub keys `hub.appeals.reasonCode.*`, `hub.appeals.cause.*`, `hub.terms.flag.*`, `hub.settings.filters.hits.overturned`, `hub.settings.appeals.*` for the three settings, in en, es, pt.

- [ ] **Step 1: Write the failing tests** (a radio group of the outcome's three codes, the first preselected, reset on a change of outcome, always sent; the English labels equal core's sentences; "What caused this" only in Detailed behind a disclosure for each of the four causes, the term masked until Show, no term text without `terms.read`; a flag at the `min` edge with the dry-run link; the filter count beside its hits; settings fields validated and saved through the policy route).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement** reusing existing components (`Masked`, `LocalReveal`, `Link`, `Card`, the decision bar's `ReasonChips` pattern).
- [ ] **Step 4: Run green**; typecheck, lint; the hub a11y and locale tests the brief names.
- [ ] **Step 5: Commit.**

### Task A11: `AppealPage` in player-react

**Files:**
- Create: `packages/player-react/src/appeal/AppealPage.tsx`, `appealClient.ts`, `index.ts`, `words.ts`
- Modify: `packages/player-react/package.json` (exports `./appeal`, `typesVersions`), `src/styles.css` (only if a class is missing), `README.md`
- Create: `packages/player-react/test/appeal-page.test.tsx`, `appeal-page-client.test.ts`, `appeal-page-size.test.ts`; modify `no-leak.test.tsx`, `a11y.test.tsx`, `readme-mount.test.ts`

**Interfaces:**
- Consumes: A5 (`AppealCase` type), A6 (`noticeWordsFor`), A8 (the JSON routes).
- Produces: `@chatwarden/player-react/appeal` exporting `AppealPage(props: { endpoint: string; token: string; locale?: string; words?: AppealWordOverrides; fetch?: typeof fetch; timeZone?: string })`, `createAppealPageClient(o: { endpoint: string; fetch?: typeof fetch }): AppealPageClient` with `load(token): Promise<AppealCase | 'invalid'>` and `send(token, statement): Promise<...>`, `readAppealToken(search: string): string | null`.

- [ ] **Step 1: Write the failing tests** (the same five states as the served page; no cookies, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`; the client keeps only known fields; refusals in words; a11y; the entry is under its size budget and the main entry's budget is unchanged).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**; typecheck, lint, `size.test.ts`.
- [ ] **Step 5: Commit.**

## Chunk 6: feed, docs, release

### Task A12: Discord feed and webhook events

**Files:**
- Modify: `packages/discord/src/feed.ts` (`sanction.overturned` handler), `packages/http/src/webhooks/out.ts` (docs of the new event; nothing else if events are passed through)
- Create: `packages/discord/test/feed.overturned.test.ts`; modify `feed.appeals.test.ts`, `packages/http/test/webhooks.appeals.test.ts`

**Interfaces:**
- Consumes: A3 (`sanction.overturned`), A2 (`appeal.decided.reason`).
- Produces: a feed post "Overturned on appeal: an automatic restriction from the slur list." (and the filter, AI and moderator variants), never the term text or an id except the hub link.

- [ ] **Step 1: Write the failing tests.** [ ] **Step 2: Red.** [ ] **Step 3: Implement.** [ ] **Step 4: Green**, typecheck, lint. [ ] **Step 5: Commit.**

### Task A13: Docs and recipes

**Files:**
- Create: `docs/recipes/appeal-emails.md` with its golden under `examples/recipes/cases/` (as the other recipes)
- Modify: `packages/core/README.md`, `packages/http/README.md` (library-mode `landingUrl` line, query strings out of access logs, the routes, the env), `packages/store-sqlite/README.md` (one "Migration 27" section judged against the SQL), `packages/store-memory/README.md`, `packages/hub-react/README.md`, `packages/player-react/README.md`, `packages/discord/README.md`, `docs/recipes/service-mode.md`, `docs/privacy-requests.md`, `scripts/readme.test.ts`'s lists as the tests require

**Interfaces:** Consumes everything above; produces text only.

- [ ] **Step 1: Write the failing checks** (the recipe's content check that it says the kit never sends email and never stores an address; the README tests; `scripts/privacy-docs.test.ts`; the store-sqlite README test against the migration SQL).
- [ ] **Step 2: Run red.** [ ] **Step 3: Write the docs.** [ ] **Step 4: Run green.** [ ] **Step 5: Commit.**

### Task A14: Release prep, 0.2.1

**Files:**
- Create: `.changeset/<name>.md` (patch, all ten packages, upgrade notes naming each raised floor and the API that forced it)
- Modify (by `npm run version` and by hand): the ten `package.json` and `CHANGELOG.md`, `package-lock.json`, `packages/*/src/version.ts` through `scripts/sync-version.mjs`, `examples/tiny-chat/package.json`, `services/corpus/package.json` (the matcher pin), peer ranges per the Global Constraints, `scripts/manifests.test.ts`, `scripts/changelog.test.ts`, the package READMEs that name versions, `docs/status.md`, `site/public/llms.txt`, `RELEASING.md` (floors line)

**Interfaces:** Consumes everything; produces the release commit.

- [ ] **Step 1: Write the failing checks** (`manifests.test.ts` expects the new floors; `changelog.test.ts` expects a 0.2.1 section above 0.2.0 in all ten).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: `npx changeset` file, then `npm run version`; set the floors; fix the pins; write changelog corrections, READMEs, status and llms.txt.**
- [ ] **Step 4: Gates, with everything built:** `npm run build`, `npm run check:pack`, `node scripts/smoke.mjs`, the size tests by path (player-react `size.test.ts` and `appeal-page-size.test.ts`, hub-react `size.test.ts`, hub-element's size test), `scripts/manifests.test.ts`, `scripts/changelog.test.ts`, `scripts/readme.test.ts`, `scripts/browser-bundle.test.ts`; typecheck and lint.
- [ ] **Step 5: Commit.** (No tag and no push: publishing is the owner's.)

## Self-review

- **Spec coverage:** 3.1 and 3.2 (A5), 3.3 and 3.4 (A8), 3.5 (A7), 3.6 (A2), 3.7 and 6.1 (A3), 4.1 (A5, A9), 4.2 (A5, A8, A11), 4.3 (A6, A7), 5.1 (A4, A10), 5.2 (A2, A6, A10), 6.2 (A4, A10), 6.3 (A3 pins it), 6.4 (A4), 6.5 (A9), 7 (A1, A2, A3, A5), 8 (the builder's: A8 template, A10 layout), 9 is out of scope (Moxgate, after publish), 10.1 to 10.10 (A1 to A9), release (A14).
- **Names:** `recordOverturn`, `latestAutoChatStart`, `overturnedTermCounts`, `overturnedFilterCounts`, `purgeOverturns`, `loadNotice` (A1, A2) are the only new Store methods; `AppealCase`, `AppealCause`, `AppealReasonCode`, `NoticeDelivery` are defined once (A5, A4, A2, A7) and used by name afterwards.
- **Proportion:** the briefs hold the SQL, the full word lists, the test lists and the commands; this document holds the decisions.
