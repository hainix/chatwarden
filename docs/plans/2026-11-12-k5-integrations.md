# K5: integrations with outside moderation and game platforms (Discord bot, Coop, EOS) (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** three opt-in integrations, each shippable on its own, inside the packages that exist today.
- **Discord bot** (`@chatwarden/http/discord`): a signed interactions endpoint, `/chatwarden lookup <ref>`, and optional "act from Discord"
  (two buttons on a report post with a confirm step, role checks mapped to the kit's roles, audited, idempotent). `@chatwarden/discord`
  gains a generic `components` hook and strips the buttons when the report closes.
- **Coop** (`@chatwarden/http/coop`): reports out as Coop jobs, decisions back through a verified callback into `cw.decide`, setup checklist
  and verify, the kit's AI severity in the item, an optional signed signal route and a copy-in Coop plugin.
- **EOS** (`@chatwarden/http/eos`): kit sanctions pushed to EOS (create, remove), EOS player reports for players the game can seat pulled
  into kit reports.

**Architecture:**
- `@chatwarden/core` gets two `@experimental` additions: `cw.sanctions.byRef(refCode)` (no migration) and `cw.links` (one table, one migration).
- `@chatwarden/store-memory` and `@chatwarden/store-sqlite` implement the optional link and by-ref store methods and pass the contract suite.
- `@chatwarden/http` gets `src/discord/`, `src/coop/`, `src/eos/`, a shared `src/internal/deliveryQueue.ts` (extracted from `webhooks/out.ts`) and a
  shared `src/admin/decideAs.ts` (extracted from `POST /reports/:id/decide`). New subpaths `@chatwarden/http/discord`, `/coop`, `/eos`; **not**
  exported from the root (they use `node:crypto`).
- `@chatwarden/discord` gets `components` and message-edit support in the feed; no new core name.
- `examples/coop-signal/` is a copy-in Coop plugin (not a workspace package, not published).
- **No new npm package.** The OIDC publish path is unchanged and the owner has no first publish to do.

**Spec:** `docs/design/2026-11-12-k5-integrations.md` (section numbers below refer to it), including its closing Rulings section. Also binding:
`docs/design/2026-11-09-product-scope.md` section 8, `docs/design/2026-11-09-chatwarden-design.md` ("Two review backends": the parts this note
does not replace), and `RELEASING.md`.

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly` (no parameter properties, no enums), every
  timestamp from an injected `Clock` (no `Date.now()` call in package code beyond the `options.clock ?? systemClock` default the other adapters use),
  synthetic terms only in code, tests and docs (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn; player names, rule titles and chat
  lines in fixtures are these too; Discord and EOS ids in fixtures are obviously fake digits and `example` strings), test-first, targeted runs only,
  `npm run lint` and `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec, `git add` new files first.
  Branch `k5`, worktree `C:\dev\chatwarden-wt\k5` (the design branch is `k5-design`; implementation branches off `main` after it merges).
- **Sequencing.** Step 0, before Task A1: rebase on `main`; read the tail of `packages/store-sqlite/src/migrations.ts` and pick the next free migration
  number for Task A2 (22 if neither the appeals nor the flood-control release has merged); check whether `main` has the K3c AI read (Task C5's `read`
  seam is a function either way). Nothing in this plan edits a file another in-flight plan owns except `packages/core/src/types.ts` (new optional
  `Store` methods, additive), `packages/store-*/src/*` (additive) and `packages/http/package.json` (exports); resolve a conflict by keeping both.
- **Opt-in, nothing at import.** No module in the three new subpaths runs code at import. Each adapter is a function; nothing reads `process.env`.
  `sideEffects: false` stays. A test per subpath imports it and checks that no timer, listener or request exists afterwards.
- **Nothing identifies a player or leaks a credential.** No log line, error message, response body or Discord post contains a secret (API key, client
  secret, bot token, interaction token, signature), a subject id (outside `hubLink` URLs, as the feed already does), an outside account id, chat text or
  a handle. Logs carry event names and error classes only (`safeWarn`, `errorClass`).
- **Verify before parse; one 401.** Every inbound route verifies the signature over `rawBody` before it parses anything, and every verification failure
  (missing header, bad shape, stale timestamp, wrong key, replay) is the same `401 { "error": "unauthorized" }`.
- **Fenced and fail-open for the kit.** Every listener and every route handler is fenced: an outside failure never changes a kit operation's result.
- **Colour and UI.** The only UI is the Discord post. At most two buttons plus a link on a report post, only when "act from Discord" is on. No hub change.
- All new public names are `@experimental` in TSDoc and listed so in the READMEs until 0.2.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no live call to Discord, Coop or EOS without the maintainer's go-ahead; the live
  checks are manual tasks the maintainer runs or approves.

## Review Focus
Six failure modes no task's happy-path tests would otherwise exercise; each has its test in the owning task.
1. **A forged or replayed request acting.** A wrong key, a flipped body byte, a stale or future timestamp, a missing or malformed header, a replay, a `custom_id`
   edited to another action, a Coop body whose signature is for another body: none may reach `cw.decide`, and every one is the same 401 (or, for a verified but
   invalid custom_id, a fixed ephemeral refusal). Tasks D3, D5, C3.
2. **A role or actor chosen by the caller.** Nothing in a Discord payload (other than the signed `member.roles` and `user.id`), a `custom_id` or a Coop body may pick
   the kit role, actor, source or permission. A permanent ban from Discord below `senior` is refused; a Discord click never takes a case over. Tasks D4, D5, C3.
3. **Text and identifiers leaving.** Seed distinctive chat text, handles, reasons, notes, subject ids, client keys, tokens and account ids; scan every Discord post
   and answer, every Coop body (for each `evidence`, `includeNote` and `handles` combination), every EOS body and every log line. Only what the design allows appears. Tasks D2, D4,
   D5, C2, C3, E2, E3 and the cross-cutting task X1.
4. **Two systems deciding at once.** The report decided in the hub between a preview and its confirm; two Discord confirms racing; a Coop callback after a hub decision;
   a duplicate callback; a Coop callback for an unknown item or action. First decision wins, nothing is applied twice, nothing is 4xx that should be acknowledged. Tasks D5, C3.
5. **Lifecycle leaks and duplicates after a crash.** Timers cleared on `dispose()`, no write after dispose, queues bounded; a simulated crash between an outside success and the
   link write sends the report to Coop at most once more (`sweep`) and never creates a second EOS sanction (reconcile before create). Tasks C2, E2.
6. **Hostile outside data.** A Discord option value, a Coop `custom` object, an EOS `message`, `context` and `time` are length-capped, shape-checked and rendered inert; an EOS
   `context.lineId` is read only when it is a short string; a `time` in the future cannot move the cursor past now plus a minute. Tasks D4, C3, E3.

## Order and parallelism
Step 0 first. The shared tasks A1, A2, A3 and A4 are independent and can run at once. Then the three groups are independent of each other:
- **Group D (Discord bot):** D1 and D2 (the feed) are independent of the rest and of http. D3 follows nothing. D4 follows D3 and A1. D5 follows D3, D4 and A3. D6 follows D4 and D5.
  D7 follows D3. D8 follows D2, D5 and D6. D9 follows D8. D10 is manual.
- **Group C (Coop):** C1 follows A2, A3, A4. C2 follows C1. C3 follows C1 and A3. C4 follows C2. C5 follows C1. C6 follows C5. C7 follows C2, C3 and C4. C8 is manual.
- **Group E (EOS):** E1 follows A4. E2 follows E1 and A2. E3 follows E1 and A2. E4 follows E2 and E3. E5 is manual.
- **X1 (cross-cutting checks)** follows whichever groups are in the release; **R (release prep)** is last, for the groups that ship.
A group ships when its own tasks, its README, X1's checks for it and R are green; the others can wait for a later release.

---

## Group A: shared foundations

### Task A1: `cw.sanctions.byRef` (core, both stores)
Design 5.2. No migration. Needed by Group D (lookup).
- **Files:** `packages/core/src/types.ts` (optional `Store.sanctionGroupByRef?(refCode): string | null`), `packages/core/src/chatwarden.ts` (`sanctions.byRef`, `@experimental`),
  `packages/core/src/sanctions.ts` (a pure `normalizeRefCode(text): string | null`, exported), `packages/store-memory/src/memoryStore.ts` (reads `refOwners`),
  `packages/store-sqlite/src/sqliteStore.ts` (uses the existing `kit_sanctions_ref_code` index), `test/contract/sanctions.contract.ts`; tests `packages/core/test/sanctions-by-ref.test.ts`,
  additions to the two stores' contract runs.
- **Interfaces (Produces):** `byRef(refCode: string): PersonSanctionView | null` (design 5.2); `normalizeRefCode('m-7k3q9' | '7K3Q9' | ' M-7K3Q9 ')` -> `'M-7K3Q9'`; anything that is not `M-` plus 5 characters of
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789` after normalising -> `null`. A non-string is a `TypeError`. A store without the method: the facade reads the newest 1 000 groups through `listSubjectSanctions`.
- **Tests (names):**
  - `byRef finds a live group, an ended group and a lifted group, with person and the SanctionGroupView fields`
  - `byRef accepts lower case, surrounding spaces and a bare five character code; rejects four and six characters, an ambiguous letter (I, L, O, U, 0, 1) and an empty string`
  - `byRef never returns an IP row, a hash or a stored value (the object holds exactly the SanctionGroupView keys plus person)`
  - `byRef for a merged person returns the canonical person`; `byRef(123) throws TypeError`
  - `a store without sanctionGroupByRef falls back to the newest 1000 groups and finds a recent code, and answers null for an old one` (a scripted store)
  - contract: `sanctionGroupByRef returns the group id for a code, null for an unknown one, and still finds it after the group is revoked` (both stores)
- **Run:** `npx vitest run packages/core/test/sanctions-by-ref.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts`

### Task A2: `cw.links` (core, both stores, one migration)
Design 5.1. Needed by Groups C and E; not by D.
- **Files:** `packages/core/src/links.ts` (new: `LINK_SYSTEMS`, `LinkRow`, `checkLinkRow`), `packages/core/src/types.ts` (optional `Store.getLink?`, `putLink?`, `listLinks?`, `purgeLinks?`),
  `packages/core/src/chatwarden.ts` (`links`, `supported`), `packages/core/src/retention.ts` and the purge path (rows older than `reportsMs`), `packages/core/src/index.ts` (exports),
  `packages/store-memory/src/memoryStore.ts`, `packages/store-sqlite/src/migrations.ts` (migration N from Step 0) and `sqliteStore.ts`, `test/contract/links.contract.ts` (new, added to `test/contract/index.ts`);
  tests `packages/core/test/links.test.ts`, `packages/store-sqlite/test/links.store.test.ts` (migration: a database at N-1 upgrades; the table and index exist; a database at N opens in the release before: additive).
- **Interfaces (Produces):** exactly design 5.1. `put` throws `RangeError` (message names the field, never the value) for a system outside the list, a `ref` or `external` outside 1 to 128 characters of the allowed set, a `state` outside
  1 to 32 characters of `a-z _ .`, an `at` that is not a finite non-negative number. `list(system, { state?, limit? })`: oldest `at` first, then `ref`; limit clamped to 1..500.
- **Tests (names):**
  - `get returns null for an unknown row; put inserts, put again replaces (same system and ref), a different system with the same ref is another row`
  - `list filters by system and by state, orders oldest first, clamps limit to 1..500 and defaults to 100`
  - `put refuses an unknown system, a ref with a space or a slash, an external of 129 characters, an empty state, a state with an upper-case letter, a NaN at; no message contains the value`
  - `purge deletes links older than retention.reportsMs and keeps newer ones; a store without the methods purges nothing and reports supported false`
  - `a link row never holds text: the accepted ref and external alphabets contain no space and no punctuation beyond _ . : # -`
  - contract (both stores): `put/get/list/purge round-trip`; sqlite: `migration N creates kit_links and kit_links_by_state; a v(N-1) database upgrades in place`
- **Run:** `npx vitest run packages/core/test/links.test.ts packages/store-memory/test/contract.test.ts packages/store-sqlite/test/contract.test.ts packages/store-sqlite/test/links.store.test.ts`

### Task A3: the shared decision path (http, behaviour-preserving)
Design 6.6 step 9, 8.4 step 9. Needed by D5 and C3.
- **Files:** `packages/http/src/admin/decideAs.ts` (new), `packages/http/src/admin/reports.ts` (`POST /reports/:id/decide` calls it), `packages/http/src/webhooks/in.ts` is **not** changed (its decide differs on claims and role); tests
  `packages/http/test/decide-as.test.ts`; the existing `admin.reports.test.ts`, `admin.quick-dismiss.test.ts` and `webhooks/in.test.ts` are the safety net and stay green unedited.
- **Interfaces (Produces):**
  `decideAs(cw: Chatwarden, input: { reportId: string; decision: ParsedDecision; actor: string; role: Role; permissions: Permissions; source?: Source; claims: 'gate' | 'ignore'; takeOver?: boolean; canOverride?: boolean }): Promise<{ replay: boolean; groups: Array<{ refCode: string; kind: SanctionKind }> }>`
  Runs, in the staff route's order: `needForDecision` (against `permissions`), the report read, `checkDurationsOffered` for an open report, the claim gate (`claims: 'gate'`: another holder is `ClaimedError`; a takeover only when `takeOver` and `canOverride`; `'ignore'`: no gate), `applyDecision` (with `source`, default `moderator`), and `releaseWhenDone` when not a replay.
  It throws the same `HttpError`s the route throws today. It does not audit (the caller does; audit modes differ). `applyDecision` gains an optional `source` argument (default `moderator`).
- **Tests (names):**
  - `decideAs matches the staff route: a ladder decision, a dismissal, a note, a bad faith with evidence, a replay, already_decided, an unknown report, a person not on the report`
  - `decideAs gates a claim held by another actor and passes the actor's own; takeOver needs canOverride; claims 'ignore' never gates`
  - `decideAs refuses a permanent ban below the senior permission and a decision whose length is not offered when customDuration is off`
  - `decideAs with source coop writes the sanction row with source coop and automated false`
  - `decideAs releases the case on the last open report and not on a replay`
  - the route's own tests, unedited, stay green (run listed below)
- **Run:** `npx vitest run packages/http/test/decide-as.test.ts packages/http/test/admin.reports.test.ts packages/http/test/admin.quick-dismiss.test.ts packages/http/test/webhooks/in.test.ts`

### Task A4: the shared delivery queue (http, behaviour-preserving)
Design 5.4. Needed by C and E (and used by `webhooksOut` so the rules cannot drift).
- **Files:** `packages/http/src/internal/deliveryQueue.ts` (new), `packages/http/src/webhooks/out.ts` (uses it); tests `packages/http/test/delivery-queue.test.ts`; `packages/http/test/webhooks/out.test.ts` is the safety net and stays green unedited.
  (The Discord forum client keeps its own copy: its constants differ, 0.5 s floor, and its tests are large; it is not touched.)
- **Interfaces (Produces):** `createDeliveryQueue<Job>(opts: { send(job: Job, signal: AbortSignal): Promise<Attempt>; clock: Clock; random: () => number; logger?: Logger; event: string; max?: number }): { push(job: Job): void; dispose(): void; size(): number }` where
  `Attempt = { kind: 'ok' } | { kind: 'final'; status: number } | { kind: 'retry'; status?: number; error?: string; afterMs?: number }`; constants as `webhooks/out.ts` exports (`MAX_RETRIES` 5, `ATTEMPT_TIMEOUT_MS` 10 000, `BACKOFF_BASE_MS` 1 000, `RETRY_AFTER_FLOOR_MS` 1 000, `RETRY_AFTER_CAP_MS` 60 000, `QUEUE_MAX` 1 000). One job in flight, in order; overflow drops the oldest and logs a coalesced `<event>_dropped` count at most once a minute; a failure for good logs `<event>_failed` (status or class, attempts).
- **Tests (names):**
  - `retries 5 times after 1, 2, 4, 8, 16 s with jitter, then logs once and goes on to the next job`; `a 429's retry-after is clamped to 1..60 s`; `a 4xx is final at once`
  - `one at a time and in order; a slow job holds the next`; `overflow drops the oldest and logs one coalesced count per minute`
  - `dispose aborts the attempt in flight, clears the timers and ignores later pushes`; `a throw in send is a retry, logged by class only`
  - `webhooksOut behaves as before (its own tests)`
- **Run:** `npx vitest run packages/http/test/delivery-queue.test.ts packages/http/test/webhooks/out.test.ts`

---

## Group D: the Discord bot

### Task D1: the feed's `components` hook (discord)
Design 6.3. Independent of http.
- **Files:** `packages/discord/src/components.ts` (new: types, `checkRows`), `packages/discord/src/forum.ts` (`ForumMessage.components`, `with_components=true` only when present, payload `components`), `packages/discord/src/feed.ts` (`components` option, called only for `report.created`), `packages/discord/src/index.ts` (exports);
  tests `packages/discord/test/components.test.ts`, additions to `feed.test.ts` and `forum.test.ts` (new `describe`; the existing ones unedited).
- **Interfaces (Produces):** `DiscordButton`, `DiscordActionRow`, `checkRows(rows: unknown): DiscordActionRow[] | null` (null when invalid: more than 1 row of more than 5 buttons, a style outside 1..5, a label empty or over 80 characters, a `custom_id` empty or over 100 or on a link button, a `url` over 512 or not http(s) or on a non-link button, a type other than 2). `DiscordFeedOptions.components`.
- **Behaviour:** a report post with valid components is sent with `?wait=true&with_components=true` and `components` in the body; an invalid result, or a throw, drops the buttons for that post and logs `chatwarden.discord_link_dropped`-style (`op: 'components'`, `reason: 'invalid'` or the error class, coalesced as links are) and the post is sent as today. Every other post is byte-identical to today (a snapshot of one of each kind).
- **Tests (names):**
  - `checkRows accepts a row of dismiss, suggestion and link buttons; rejects 6 buttons, a 81 character label, a 101 character custom_id, a link with a custom_id, a button with a url, a javascript: url, a 513 character url, a non-array`
  - `the report post carries with_components=true and the components; no other post carries either`
  - `a components function that throws or returns junk posts the report without buttons and logs one coalesced line with no custom_id, label or url in it`
  - `the components function is called with { kind: 'report', reportId } and nothing else; it is never called for sanction, gap or timeout posts`
  - `every existing post kind is byte-identical to before when components is not set`
- **Run:** `npx vitest run packages/discord/test/components.test.ts packages/discord/test/feed.test.ts packages/discord/test/forum.test.ts`

### Task D2: strip the buttons when the report closes (discord)
Design 6.3. Follows D1.
- **Files:** `packages/discord/src/forum.ts` (`ForumClient.edit(threadId, messageId, patch)`: `PATCH /webhooks/{id}/{token}/messages/{messageId}?thread_id=..&with_components=true`, same retry rules, serialised with the other calls), `packages/discord/src/feed.ts` (a bounded `reportId -> { threadId, messageId }` map filled from the `wait=true` answer of a post with components; on `report.closed` an `edit` job with `components: []`); tests additions to `feed.test.ts`, `forum.test.ts`.
- **Behaviour:** `severeOnly` and role-ping rules are unchanged. The edit is skipped when the map has no entry (a restart, an overflow). A thread that was deleted (`10003`) is not recreated for an edit. The edit never changes `content`.
- **Tests (names):**
  - `report.closed edits the report's own post to no components, in the right thread, once`; `an edit failure is logged by class and does not block the next post`
  - `after a restart (a new feed) a closed report edits nothing and posts nothing wrong`; `the map is bounded at 10000 and forgets the oldest`
  - `edit keeps the queue order: a post queued before the close is sent before the edit`; `dispose drops a pending edit`
  - `the edit body is { components: [] } only: no content, no mentions, and allowed_mentions parse is empty`
- **Run:** `npx vitest run packages/discord/test/feed.test.ts packages/discord/test/forum.test.ts packages/discord/test/components.test.ts`

### Task D3: the interactions endpoint, verification and ping (http)
Design 6.4, 6.5 (request and ping), 10. Follows nothing.
- **Files:** `packages/http/src/discord/index.ts`, `options.ts`, `verify.ts`, `bot.ts` (new), `packages/http/package.json` (`exports["./discord"]`, `typesVersions`), `vitest.config.ts` (alias `@chatwarden/http/discord` before `@chatwarden/http`), `tsconfig` if a path is needed;
  tests `packages/http/test/discord-world.ts` (the fake: Ed25519 key pair via `node:crypto`, signed-interaction builder, response reader), `discord-verify.test.ts`, `discord-options.test.ts`, `exports.test.ts` (the new subpath is **not** on the root).
- **Interfaces (Produces):** `discordBot(cw, options): DiscordBot` as design 6.4 (this task implements `routes` with verification and PING and returns a fixed ephemeral refusal for everything else; `components` returns `undefined`, `commands()` the definition, `dispose()`); `verifyInteraction(publicKeyHex, headers, rawBody, now, tolerance, replay): boolean`; `DiscordBotOptions` validation (`RangeError`, never the value).
  The public key is built once: `createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw32]), format: 'der', type: 'spki' })`.
- **Tests (names):**
  - `verify: a valid signature passes; a wrong key, a flipped body byte, a flipped timestamp byte, a missing header, a 127 or 129 character signature, non-hex, upper-case hex (accepted) and a body re-serialised with other spacing (refused) behave exactly so`
  - `verify: a timestamp 301 s old and 301 s in the future is refused, 300 s accepted; a non-numeric or 16 digit timestamp is refused; the tolerance option is honoured`
  - `verify: a replayed signature is refused the second time and accepted again after the window`
  - `the route: every verification failure is the same 401 body and no header differs; an absent rawBody is a 500 and a log; a 64 KiB + 1 body is 413 before any crypto; the body is not parsed before verification (a spy on parseJson)`
  - `a PING answers 200 { type: 1 } with content-type application/json`; `a non-POST is not routed`
  - `options: applicationId, guildId and every role id must be snowflakes; publicKey must be 64 hex; roles needs at least one id; hubLink must be a function; actions must be booleans; errors never contain the value`
  - `the object is copied: changing the adopter's roles object afterwards changes nothing`
  - `importing @chatwarden/http/discord starts nothing; the root does not export discordBot` (Review Focus 1)
- **Run:** `npx vitest run packages/http/test/discord-verify.test.ts packages/http/test/discord-options.test.ts packages/http/test/exports.test.ts`

### Task D4: guild, role, rate, and `/chatwarden lookup`
Design 6.5 (lookup), 6.6 steps 1 to 3, 6.7. Follows D3 and A1.
- **Files:** `packages/http/src/discord/roles.ts`, `lookup.ts`, `text.ts` (labels and escaping, reusing the feed's table by copy with a test that the two label tables agree), `bot.ts`; tests `discord-roles.test.ts`, `discord-lookup.test.ts`.
- **Interfaces (Produces):** `kitRoleOf(memberRoles: readonly string[], map): Role | null` (highest of the matches); the lookup handler; the command definition `bot.commands()` as design 6.5; the per-user `Limiter` (the existing class, default 20 per 60 000 ms).
- **Behaviour:** `guild_id` mismatch and no `member` (a DM) are ephemeral refusals (`This bot is not set up for this server.`); no role is `You do not have a moderator role for this bot.`; a role below `history.read` (an adopter's `permissions` can raise it) is the same; a limiter hit is `Slow down.` Lookup: `byRef`, then audit `history.view` (target `{ type: 'sanction', ref: groupId }`, **required** mode), then the answer of design 6.5. An unknown or malformed code is one text. Every answer has `allowed_mentions: { parse: [] }` and `flags: 64`.
- **Tests (names):**
  - `kitRoleOf: highest wins (a member with moderator and senior role ids is senior); an unlisted role is nothing; empty and duplicate ids; the map never matches a role name`
  - `a wrong guild, a DM and a missing member are refused with the fixed text and a log reason (guild); no role id, user id or guild id appears in the answer or the log`
  - `lookup of a live, an ended and a lifted sanction shows the code, kind, length or permanent, rule and escaped title, status, a Discord timestamp and the source in words, and an Open person link`
  - `lookup never shows the reason, actor, handle, subject id (outside the link), room id or any note` (seeded; Review Focus 3)
  - `lookup of an unknown code and of garbage give the same text; a 3 character and a 12 character option are handled (min_length 5 is Discord's job, the handler checks again)`
  - `lookup writes one history.view row with the actor discord:<id>, the mapped role and the sanction target; an audit failure shows nothing (required mode) and logs the class; a refused lookup writes no row`
  - `a rule title with markdown, an @everyone and a 2000 character title is escaped and cut`
  - `rate: the 21st lookup in a minute is Slow down; another user is unaffected; the clock moves the window`
  - `actorOf maps the audit actor; an actorOf that returns an invalid actor or throws falls back to discord:<id>`
- **Run:** `npx vitest run packages/http/test/discord-roles.test.ts packages/http/test/discord-lookup.test.ts packages/http/test/discord-verify.test.ts`

### Task D5: act from Discord (buttons, preview, confirm)
Design 6.5 (buttons), 6.6 steps 4 to 10. Follows D3, D4 and A3.
- **Files:** `packages/http/src/discord/customId.ts` (the `cw1` grammar: `encode`, `parse`), `act.ts` (preview and confirm), `bot.ts` (`components()` real, dispatch), tests `discord-custom-id.test.ts`, `discord-act.test.ts`, `discord-act-conflicts.test.ts`.
- **Interfaces (Produces):** `encodeCustomId({ verb: 'dis' | 'sug' | 'ok' | 'x', reportId?, code? })`, `parseCustomId(s): Parsed | null` (a closed grammar; null for anything else, never throws; at most 100 characters); `codeOf(action): string` and `actionOf(code): DecisionAction-shape | null`; `bot.components(post)`: with `actions` set, one row of `[Nothing wrong here] [Apply suggestion]? [Open report link]`, else `undefined`.
- **Behaviour:** exactly design 6.6 steps 4 to 10: `off`, report state, claim, rule, preview (`cw.suggest` with `{ roomId }`, audit `suggest` **required**), confirm (`decideAs` with `claims: 'gate'`, no takeover, `source: 'moderator'`, reason `Profile suggestion, accepted in Discord` or the standard dismissal reason; audit `report.decide` best-effort), `UPDATE_MESSAGE` answers, `Already done` for a replay, the "decided" answer for a closed report. The confirm re-derives the suggestion and refuses (`That changed. Open it in the hub.` + link) when the code differs. The interaction id is remembered for 15 minutes (bounded 10 000).
- **Tests (names):**
  - `custom_id: round-trips every verb and every action code; the longest possible (32 character report id, ban.p.1, chat.31536000000.6) is at most 100 characters; garbage, an unknown version, a 101 character string, a report id with a colon or a space, a negative duration, an unknown kind all parse to null`
  - `components: off by default (undefined); with actions the row has the two buttons and the link; with suggestion false only dismiss and the link; the link is hubLink('report', id); a hubLink that throws drops the link, not the row`
  - `dismiss: preview shows a confirm, confirm closes the report no_action with the standard reason, actor discord:<id>, source moderator; one report.decide row; the report.closed event fires once; the answer is UPDATE_MESSAGE with no buttons`
  - `suggestion, for each outcome (none, note, warning, chat, area, ban with a length, ban permanent): the preview names the step, the rule and the why; confirm applies exactly that; a permanent ban from a moderator role is refused (forbidden text), from a senior is applied`
  - `a report whose suggested rule is uncovered cannot be acted on from Discord; a dismissal can`
  - `with actions.confirm false the first click decides directly (the preview is skipped), with the same role, claim, rule, offered-length and audit checks and the same answer as a confirm`
  - `claims: a claim held by another actor refuses with the fixed text and writes nothing; the actor's own claim passes (actorOf mapped); a Discord click never takes over and never creates a claim`
  - `decided in the hub between preview and confirm: the confirm answers already decided with the verdict word, no write, no second report.closed`
  - `two confirms racing: one applies, the other answers Already done (same code) or already decided (another code); one sanction row; one notice`
  - `a repeated delivery of the same interaction id is answered without a second write; a different interaction, same code, is a replay of the decision`
  - `a custom_id forged to another report id the clicker may decide works as that report (it is a report they may decide anyway); forged to a code that is not the current suggestion is refused; forged to an unknown verb is a fixed refusal; none of them changes role, actor or source`
  - `actions off: a cw1 button is answered Actions from Discord are turned off and writes nothing`
  - `no answer or log contains the chat text, handle, reason or evidence of the report (seeded; Review Focus 3); allowed_mentions parse is empty on every answer`
  - `an audit failure on preview shows nothing; on confirm the decision stands and the failure is logged by class`
- **Run:** `npx vitest run packages/http/test/discord-custom-id.test.ts packages/http/test/discord-act.test.ts packages/http/test/discord-act-conflicts.test.ts`

### Task D6: slow work: deferred answers and the follow-up
Design 6.5 (deferred). Follows D4, D5.
- **Files:** `packages/http/src/discord/respond.ts` (race, defer, follow-up), `bot.ts`; tests `discord-defer.test.ts`.
- **Behaviour:** the handler races its work against `respondWithinMs` (default 2 500, clock-injected timer so the test controls it); if the timer wins it answers `{ type: 5, data: { flags: 64 } }` (a command) or `{ type: 6 }` (a component) and, when the work finishes, sends one `PATCH https://discord.com/api/v10/webhooks/<applicationId>/<token>/messages/@original` through `fetch` (the application id and the token are checked by shape first). A 429 is honoured once (clamped 1 to 60 s); any other failure is logged by class. The token is never logged or stored. A work that throws answers the fixed `Something went wrong. Try again in the hub.`
- **Tests (names):**
  - `fast work is answered inline; slow work is answered type 5 (command) or 6 (component) within respondWithinMs and finished by one PATCH of @original with the same content the inline answer would have had`
  - `the follow-up uses the fixed host, a token that matches the shape, and no Authorization header`; `a token of the wrong shape sends nothing and logs a class`
  - `a follow-up 429 retries once after the clamped wait; a 500 is logged and dropped; dispose cancels a pending follow-up`
  - `the interaction token never appears in a log line, an error or a store row`
- **Run:** `npx vitest run packages/http/test/discord-defer.test.ts packages/http/test/discord-lookup.test.ts packages/http/test/discord-act.test.ts`

### Task D7: `registerCommands`
Design 6.1. Follows D3.
- **Files:** `packages/http/src/discord/register.ts`; tests `discord-register.test.ts`.
- **Interfaces (Produces):** `registerCommands(options)` as design 6.4: `PUT https://discord.com/api/v10/applications/{applicationId}/guilds/{guildId}/commands` with `Authorization: Bot <token>` and the command list; ids checked by shape; `{ ok: true, count }` on 200 (`count` the length of the answer array), `{ ok: false, status }` otherwise; one retry on 429 after its `retry_after`; the token is never in the result, an error or a log.
- **Tests (names):** `puts the bulk list to the guild route with the bot authorization; the body is bot.commands(); count is the answer's length`; `a bad id or an empty token is a RangeError without the value`; `a 401 and a 400 are { ok: false, status }; a 429 retries once`; `the token never appears in any output`.
- **Run:** `npx vitest run packages/http/test/discord-register.test.ts`

### Task D8: the whole loop with the real feed and the real kit
Design 6 end to end. Follows D2, D5, D6.
- **Files:** `packages/http/test/discord-e2e.test.ts` (the real core over `MemoryStore` and the real `discordFeed` with `components: bot.components` on a fake Discord webhook, the real `discordBot` routes behind the real router and `toExpress` on port 0 with a real `fetch`; no network beyond localhost).
- **Tests (names):**
  - `a report is filed: the feed posts it with the two buttons; the click on Nothing wrong here previews, Confirm decides, the feed posts the outcome and strips the buttons`
  - `the same report decided in the hub first: the click answers already decided and the feed has already stripped the buttons`
  - `a suggestion click applies the ladder step; the player's notice exists (cw.notices.pending) and has no Discord identifier`
  - `lookup answers a ref code from a sanction that the same test just applied`
  - `an unsigned POST to the real route is 401 over real HTTP; rawBody is the exact bytes (a body with unicode and a trailing newline verifies)`
  - `dispose of the feed and the bot leaves no timer and no listener`
- **Run:** `npx vitest run packages/http/test/discord-e2e.test.ts`

### Task D9: Discord docs
Design 6, 14. Follows D8.
- **Files:** `packages/discord/README.md` (the feed "has no buttons" sentence becomes the `components` option and the application-owned webhook note), `packages/http/README.md` (a "Discord bot" section: setup in order, the exact `curl` to create the application-owned webhook, what each answer says, the roles map, security notes, edge rate limiting), `README.md` (the "I want to" table and the package table), `docs/status.md`, `docs/plans/follow-ups.md`, `CLAUDE.md` (the package table rows); tests `scripts/readme.test.ts` (new code blocks compile), `packages/http/test/readme.test.ts`.
- **Tests (names):** `the readme code blocks for discordBot, registerCommands and the feed wiring compile and run against the fakes`; `every documented option name exists`; `the READMEs list the @experimental names`.
- **Run:** `npx vitest run scripts/readme.test.ts packages/http/test/readme.test.ts`

### Task D10 (manual): the live Discord check
Design 15 rows 1 and 2. Run by the maintainer, or with their go-ahead. A throwaway guild and application. Steps: create the application, bot and application-owned webhook as the README says; deploy the route; save the Interactions Endpoint URL (the PING); `registerCommands`; post a report and look for the buttons (settles row 1: ownership, and whether `wait=true` carries `application_id`); click through dismiss and suggestion; run `/chatwarden lookup`; confirm `1 << 40` is `MODERATE_MEMBERS`. Record the results in the design's section 15 and fix the README where they differ. If row 1 fails, stop and raise open question 1 (the bot-token transport).

---

## Group C: Coop

### Task C1: Coop wire types and the pure mappers
Design 8.3, 8.4. Follows A2, A3, A4 (types only need A2).
- **Files:** `packages/http/src/coop/index.ts`, `options.ts`, `wire.ts` (new), `packages/http/package.json` (`exports["./coop"]`, `typesVersions`), `vitest.config.ts` (alias); tests `packages/http/test/coop-world.ts` (the fake: strict report-schema validation, scripted answers, RSA key pair, a callback maker for both header shapes), `coop-options.test.ts`, `coop-wire.test.ts`.
- **Interfaces (Produces):** `CoopOptions`, `CoopDecision`, `CoopAdapter` as design 8.1; `buildReport(report: StaffReport, opts, cwView): CoopReportBody` (pure: the body of design 8.3 for every `evidence` / `includeNote` / `handles` combination, labels `reporter` / `reported` / `other n`, `room` as `k=v,k2=v2` cut to 200, `reportedAt` ISO from `createdAt`, a note cut to 500, `aiSeverity` only when given and a finite number 0 to 100); `decisionOf(callback, opts, report, cw): { ok: true; decision: ParsedDecision; actor: string } | { ok: false; reason: string }` (pure: the mapping and the ignore reasons of design 8.2 and 8.4 steps 5 to 9); `actorOf(email)` (design 5.3).
- **Tests (names):**
  - `options: evidence is required and must be 'none' or 'excerpt' (RangeError naming the option); baseUrl must be https or http localhost and 127.0.0.1 with no credentials; apiKey and the PEM are checked once; actions values must be one of the CoopDecision shapes; rules values must be positive whole numbers; errors never contain a value; the object is copied`
  - `buildReport: evidence none has no thread and no lines; excerpt has the lines in order with datetime; handles hidden labels reporter, reported, other 1 and other 2 for a four person excerpt; handles shown carries the handle; includeNote false never carries the note; true cuts it to 500; the reported line is in reportedItemsInThread`
  - `buildReport never carries the room id, a seat id, a client key, a hash or the reporter's handle in a hidden-handles body (seeded; Review Focus 3); csam is absent`
  - `buildReport validates against the fake's documented schema for 40 generated combinations`
  - `decisionOf: each mapped action; an unknown action id; a policy mapped to a rule; an unmapped policy falls back to the suggested rule; no citable rule for an acting verdict is ignored with reason no_rule; bad_faith without a reason is ignored; no actorEmail is ignored; empty policies and rules is ignored; the actor is coop:<email> with disallowed characters replaced and 128 at most; an empty email is coop:unknown`
- **Run:** `npx vitest run packages/http/test/coop-options.test.ts packages/http/test/coop-wire.test.ts packages/http/test/exports.test.ts`

### Task C2: outbound: a report becomes a Coop job
Design 8.3. Follows C1.
- **Files:** `packages/http/src/coop/outbound.ts`, `index.ts` (subscribe, `sweep`, `dispose`); tests `coop-outbound.test.ts`.
- **Behaviour:** on `report.created`: fenced, read `cw.reports.get`, skip when `cw.links.get('coop-report', id)` exists, push a job on the shared delivery queue (A4); the job sends `POST {baseUrl}/api/v1/report` with `X-API-KEY`, `Content-Type: application/json`, `redirect: 'manual'`; 201 parses `{ reportId }` (a 201 without a readable id still records the link with external `unknown`), writes the link `state: 'sent'`; a 4xx other than 429 is final and logs `chatwarden.coop_failed` with the status; `sweep()` lists open reports from the last `catchUpMs` (newest 200 per page, up to 5 pages) and queues those with no link.
- **Tests (names):**
  - `a report.created sends one request with the key header, the documented body, in the queue's order; the link row is written with the coop id`
  - `a 400 is final and logged by status only; a 401 is final; a 429 honours retry-after; a 503 retries then succeeds; 6 failures are logged once`
  - `a link that already exists is not sent again; after a simulated crash between the 201 and the put, sweep sends it once more and writes the link`
  - `sweep ignores closed reports, reports older than catchUpMs and reports with a link; it sends at most what the queue holds and counts sent, skipped, failed`
  - `the aiSeverity hook: a number rides in data; a throw, NaN or 101 drops the field and sends the report`
  - `no log line contains the api key, a url, a report id, a subject id or any chat text (Review Focus 3); the request never follows a redirect`
  - `dispose unsubscribes, aborts the request in flight, clears timers and later events send nothing`; `a store without links is a RangeError at construction`
- **Run:** `npx vitest run packages/http/test/coop-outbound.test.ts packages/http/test/delivery-queue.test.ts`

### Task C3: inbound: the verified callback becomes a decision
Design 8.2, 8.4. Follows C1 and A3.
- **Files:** `packages/http/src/coop/verify.ts`, `inbound.ts`, `index.ts` (`routes`); tests `coop-verify.test.ts`, `coop-inbound.test.ts`.
- **Interfaces (Produces):** `verifyCoopSignature(publicKeyPem, headers, rawBody): boolean` (RSA PKCS#1 v1.5 SHA-256, base64; also the `t=<ts>,v1=<sig>` shape: `v1`, trying the body then `<t>.<body>`); the route `POST /coop/actions`; optional `callbackAuth` compared in constant time.
- **Behaviour:** the eleven steps of design 8.4; the answers `200 { ok: true, outcome }`, `401`, `413`, `400` (a body that is not JSON or lacks `item.id` and `action.id`), `503` (a store failure while deciding). Decision via `decideAs` with `source: 'coop'`, `claims: 'ignore'`, the configured `role` and the shared permission map; audit `report.decide` best-effort with actor `coop:<email>` and the role; then `links.put(state: 'decided')` (a failure logged, not surfaced).
- **Tests (names):**
  - `verify: a valid body-only signature passes; a wrong key, a flipped body byte, an empty header, a non-base64 header, a 2000 character header and a signature from another key fail; the t=,v1= shape passes for body and for t.body and fails for a wrong v1; the header name is read case-insensitively`
  - `every verification failure is the same 401; rawBody absent is a 500 and a log; the body is not parsed before verification`
  - `a moderator decision applies: the verdict, the sanction on the report's target, source coop, actor coop:<email>, the reason from decisionReason, one report.closed event, one audit row with the configured role`
  - `rule 1: a report closed in the hub first answers 200 ignored closed and applies nothing; rule 2: the same callback twice is applied once (replay) and answered 200; rule 3: unknown item, unknown action, no rule, bad_faith with no reason, a permanent ban from a moderator-role adapter each answer 200 ignored with a reason code and leave the report open; rule 4: an automated action and a strike threshold are ignored; rule 7: a store failure is 503`
  - `callbackAuth: a missing or wrong header is the same 401; a right one passes`
  - `an actorNote and decisionReason are stored only as the private reason (cut to 500) and appear in no log, no event and no response`
  - `a body with __proto__ keys, a 10 000 element policies array, a 100 000 character decisionReason and nested custom objects are handled (capped or ignored) without throwing`
  - `the person decided is the report's target; an action id mapped to a person not on the report is impossible (the adapter builds the action itself)`
- **Run:** `npx vitest run packages/http/test/coop-verify.test.ts packages/http/test/coop-inbound.test.ts packages/http/test/decide-as.test.ts`

### Task C4: setup checklist and verify
Design 8.5. Follows C2.
- **Files:** `packages/http/src/coop/setup.ts`; tests `coop-setup.test.ts`.
- **Interfaces (Produces):** `setup.checklist(): CoopChecklist` (`{ itemTypes: [...], policies: [{ name, policyText }], actions: [{ name, callbackUrl: '<your public URL>/coop/actions', strikes: false }], notes: string[] }` and `toText()`); `setup.verify(): Promise<CoopVerification>` (three GETs with the key; `{ policies: { missing: string[] }, actions: { missing: string[] }, itemTypes: { missing: string[]; fieldProblems: string[] } }`; never writes; a network or auth failure is `{ ok: false, status }`).
- **Tests (names):** `the checklist lists one policy per active Community Rule from cw.rules with its text and the three item types with the field names buildReport uses, and says not to use Ignore`; `verify reports a configured policy id that Coop does not list, an action id with no mapping, and an item type missing a field`; `verify makes only GETs (the fake refuses any other method)`; `a 401 is reported by status; the key never appears in the result or a log`.
- **Run:** `npx vitest run packages/http/test/coop-setup.test.ts`

### Task C5: the signal route
Design 8.7. Follows C1.
- **Files:** `packages/http/src/coop/signal.ts`, `options.ts` (`signal: { secret, read }`), `index.ts` (adds `POST /coop/signal` to `routes` only when set); tests `coop-signal.test.ts`.
- **Behaviour:** the kit's signing scheme (`verify` from `webhooks/sign.ts`, a `ReplayCache`, 5 minute window); body `{ lines: [{ label, text }], item?: { text } }` capped at 64 KiB, 50 lines, 400 characters per text (cut); `read(lines)` raced against 8 s (injected timer); answer `200 { severity }` for a finite number clamped to 0..100; `read` throwing, timing out or answering a non-number is `503` with no body; a per-secret limiter (default 60 per minute). `read` is the adopter's function: the AI read (K3c) is wired by them; the tests use a scripted one.
- **Tests (names):** `a signed request returns the severity; unsigned, stale, replayed and wrong-secret are the same 401`; `too many lines, an over-long text, a missing label and a non-string text are capped or refused as stated`; `read throwing, hanging past 8 s (fake timer) and returning NaN are 503 with an empty body`; `the limiter returns 429 with retry-after past the cap`; `no identifier is accepted or echoed: extra keys in the body are ignored and never reach read`; `the route is absent when signal is not set`.
- **Run:** `npx vitest run packages/http/test/coop-signal.test.ts packages/http/test/sign.test.ts`

### Task C6: the Coop plugin example
Design 8.7. Follows C5.
- **Files:** `examples/coop-signal/{package.json (private, not in workspaces' published set), src/index.ts, README.md}`; tests `examples/coop-signal/plugin.test.ts` (runs in the `kit` project: `examples/*/*.test.ts`).
- **Behaviour:** a manifest (`CHATWARDEN_AI_READ`, a config form with the kit URL and the secret as `password`), one numeric signal asking for the thread (`contextNeeds: { includeThread: true, maxThreadMessages: 20 }`), a `run` that signs and POSTs to the kit's `/coop/signal` with the kit's HMAC scheme (about 12 lines, `node:crypto`) and returns `{ outputType: { scalarType: 'NUMBER' }, score }`; a failure returns a disabled-style result, never a score. It depends on no `@roostorg` package at run time: the types it needs are declared structurally in the file with a comment naming the two package names the Coop docs use. The README says how to list it by local path in `integrations.config.json` and that the example is not published.
- **Tests (names):** `the signal posts a correctly signed body to a fake kit and returns its severity as the score`; `it asks for the thread and sends at most 20 labelled lines and no ids`; `a kit 503, a network error and a bad answer produce no score`; `the manifest has the required fields and the secret field is a password input`; `against the real adapter route (coop-world) the round trip works`.
- **Run:** `npx vitest run examples/coop-signal/plugin.test.ts packages/http/test/coop-signal.test.ts`

### Task C7: Coop docs
Design 8, 14. Follows C2, C3, C4.
- **Files:** `packages/http/README.md` (a "Coop" section: the options table, the three item types and their fields, the action list, the callback URL, the conflict rules in plain words, replay posture, the privacy switches, the signal route), `docs/status.md`, `docs/plans/follow-ups.md`, `README.md` (the "I want to" table: "Review in Coop"), `CLAUDE.md`; tests `scripts/readme.test.ts`, `packages/http/test/readme.test.ts`.
- **Tests (names):** `the readme code blocks for coop() compile and run against coop-world`; `every documented option exists`; `the READMEs list the @experimental names`.
- **Run:** `npx vitest run scripts/readme.test.ts packages/http/test/readme.test.ts`

### Task C8 (manual): the local Coop end to end
Design 15 rows 3 to 6; the 2026-11-09 design's "one manual end-to-end against a local Coop (`docker compose`)". Run by the maintainer, or with their go-ahead, against a local Coop at the version current then. Create the item types, policies and actions from `setup.checklist()`; `setup.verify()`; file a report (a job appears with the thread and policy); decide with Warn, Chat 24 h, Dismiss and Ignore (check which send a callback: row 4); capture the real `Coop-Signature` header (row 3: add its shape as a fixture and tighten the verifier if only one shape appears); check `creator` and `datetime` (row 5); install `examples/coop-signal` by path and use the signal in a routing rule, noting the plugin types package name (row 6). Record the results in the design's section 15; update the README and fixtures.

---

## Group E: EOS

### Task E1: the EOS client: options, token, fake
Design 9.2, 9.3 (token). Follows A4.
- **Files:** `packages/http/src/eos/index.ts`, `options.ts`, `token.ts`, `client.ts` (new: a small typed client over `fetch` for the endpoints used), `packages/http/package.json` (`exports["./eos"]`, `typesVersions`), `vitest.config.ts` (alias); tests `packages/http/test/eos-world.ts` (the fake: token endpoint with Basic auth, sanctions create, query, delete with the documented limits enforced, reports find that **refuses both player filters empty**, paging, `startTime`, scripted 401, 429, 5xx), `eos-options.test.ts`, `eos-token.test.ts`.
- **Interfaces (Produces):** `EosOptions`, `EosAdapter` as design 9.2; `createTokenSource({ clientId, clientSecret, deploymentId, baseUrl, fetch, clock }): { get(): Promise<string>; invalidate(): void }`: `POST /auth/v1/oauth/token` (`Authorization: Basic ...`, `content-type: application/x-www-form-urlencoded`, `grant_type=client_credentials&deployment_id=...`), cached until 60 s before `expires_in`, concurrent callers share one request, one refresh after a 401.
- **Tests (names):**
  - `options: deploymentId, clientId and clientSecret are required strings; baseUrl defaults to https://api.epicgames.dev and must be https (http localhost for tests); action names must match [A-Za-z0-9_-]{1,64}; reasons keys must be 1..7; the object is copied; errors never contain a value; sanctions and reports are each optional`
  - `token: one request for concurrent callers; the Basic header is base64(clientId:clientSecret) and is built per request; the token is reused until 60 s before expiry and refreshed after; a 401 from an API call invalidates and retries once; a failed token request is logged by status and class only`
  - `the client secret and the access token appear in no log line, error or stored row`
  - `importing @chatwarden/http/eos starts nothing; the root does not export eos`
- **Run:** `npx vitest run packages/http/test/eos-options.test.ts packages/http/test/eos-token.test.ts packages/http/test/exports.test.ts`

### Task E2: push: a kit sanction becomes an EOS sanction
Design 9.3. Follows E1 and A2.
- **Files:** `packages/http/src/eos/sanctions.ts`, `wire.ts` (`sanctionBody`, `durationSeconds`, `keyOf`), `index.ts` (subscribe); tests `eos-sanctions.test.ts`.
- **Behaviour:** the five steps of design 9.3 on the shared delivery queue: resolve ids, key, skip if linked, **reconcile before create** (`GET .../users/{id}` and match `metadata.cw_ref`), `POST`, write the link; `sanction.revoked` resolves the same keys and `DELETE`s the active ones; `auto.restricted` only with `includeAutomatic`; `warning` only with an action name; a `note` never.
- **Tests (names):**
  - `chat, area and ban push with the configured action names, a duration in seconds (rounded, at least 1), source chatwarden, tags cw and rule<n>, metadata cw_ref and cw_rule, a justification of the ref and rule only`
  - `a permanent sanction sends duration 0`; `a warning is pushed only when it has an action; a note never; an automatic timeout only with includeAutomatic`
  - `the moderator's private reason is never sent unless justification is 'reason'; with it, it is cut to 2048`
  - `the fake enforces EOS's limits: an action over 64 characters, a tag over 16, metadata value over 128 are refused by the fake, and the adapter never produces one`
  - `reconcile before create: after a simulated crash between EOS's answer and the link write, the retry finds the sanction by cw_ref, writes the link and creates nothing`
  - `revoke: removes the EOS sanction with the referenceId and a Lifted justification, marks the link removed; a revoke for a never-pushed group does nothing; a revoke queued before the create finished runs after it`
  - `two accounts for one person (aliases) push one sanction each and are removed each; productUserIdsOf throwing or returning nothing logs resolve and pushes nothing; the kit's own sanction is unaffected in every failure`
  - `a 401 refreshes the token once; a 429 honours retry-after; a 5xx retries; a 400 is final and logged by status`
  - `no log or error holds a product user id, a referenceId, a reason or a token (seeded; Review Focus 3); the links table holds only the hashed key and the referenceId`
  - `dispose stops everything`
- **Run:** `npx vitest run packages/http/test/eos-sanctions.test.ts packages/http/test/eos-token.test.ts packages/http/test/delivery-queue.test.ts`

### Task E3: pull: EOS player reports become kit reports
Design 9.4. Follows E1 and A2.
- **Files:** `packages/http/src/eos/reports.ts`, `index.ts` (`pollReports`, `start`, `stop`); tests `eos-reports.test.ts`.
- **Behaviour:** the four steps of design 9.4: batch the ids (default 20), page with `pagination=true&limit=50&order=time:asc` and `startTime = cursor - 10 min`, dedupe by key, place both players with `seatOf`, `cw.reports.submit` (reason from the map, note cut to 500, `lineId` only from a valid `context`), count skips and refusals by code, write links and the cursor (never beyond now plus 1 minute). `start()` polls every `pollMs` on an unref'd timer; a poll still running when the next tick fires is skipped.
- **Tests (names):**
  - `the fake's both-filters-empty refusal is never triggered: with no players the adapter makes no request`; `players are batched, deduplicated and capped at 500`
  - `a report about a seated player by a seated reporter in the same room becomes a kit report with the mapped reason, the message as the note, the kit's clock as createdAt and the line from context only when it is a string of at most 64 characters`
  - `a different room, an unseated reporter or reported player, a reason with no mapping (filed with no reason) and a reportingPlayerId equal to reportedPlayerId are skipped or filed as stated and counted`
  - `the kit's refusals are counted by code: the 11th report from one reporter in a day is refused rate and its link is skipped; a suspended reporter is refused; an unknown reason is refused`
  - `dedupe: the same report returned on two polls, and across the 10 minute overlap, is filed once; two different reports with the same time and ids but another reason are two`
  - `a time in the future cannot move the cursor past now plus a minute; a time far in the past is still found through the overlap only if within it and is otherwise missed (documented, tested)`
  - `a hostile context (a 4096 character string, nested objects, a lineId of a number, a lineId of 65 characters, __proto__) never throws and never files a line`
  - `the poll never makes the kit file a report as another person: the reporter seat comes from seatOf(reportingPlayerId) only`
  - `start polls on the timer, skips overlapping polls, does not keep the process alive, and stop and dispose end it`
  - `no log or error holds a product user id, a message or a context`
- **Run:** `npx vitest run packages/http/test/eos-reports.test.ts packages/http/test/eos-token.test.ts`

### Task E4: EOS docs
Design 9, 14. Follows E2, E3.
- **Files:** `packages/http/README.md` (an "Epic Online Services" section: what EOS's API can and cannot do, the options table, the client policy actions to allow, the two adopter functions with examples, what stays on the game client, limits), `docs/status.md`, `docs/plans/follow-ups.md`, `README.md`, `CLAUDE.md`; tests `scripts/readme.test.ts`, `packages/http/test/readme.test.ts`.
- **Tests (names):** `the readme code blocks for eos() compile and run against eos-world`; `every documented option exists`; `the READMEs list the @experimental names`.
- **Run:** `npx vitest run scripts/readme.test.ts packages/http/test/readme.test.ts`

### Task E5 (manual): the EOS sandbox check
Design 15 row 7. Run by the maintainer, or with their go-ahead, against a development deployment: push a chat sanction and a permanent ban (check `duration: 0`), remove one, file a report from a test client and poll it, try batch sizes 20, 50 and 100 for `reportedPlayerId`, and watch for 429s. Record the results in the design's section 15 and adjust the defaults.

---

## Cross-cutting and release

### Task X1: cross-cutting checks (whichever groups are in the release)
Design 10, 11 (`cross`). Follows the groups in the release.
- **Files:** `packages/http/test/integrations-cross.test.ts` (new), additions to `packages/http/test/exports.test.ts`, `scripts/browser-bundle.test.ts` (the root and `/chat` bundles still hold no `node:`; the three new subpaths are not in them).
- **Tests (names):**
  - `logs hold event names and error classes only: run each adapter through a failing fake (every status, a throwing fetch, a throwing store) with a distinctive key, token, secret, url, id and text in every option and body, and scan every log line` (Review Focus 3)
  - `construction errors never echo a value: pass a distinctive bad value to every option of every adapter` 
  - `nothing happens at import; dispose clears every timer (fake timers report zero pending) for each adapter`
  - `the three subpaths are not exported from the root; the root export list is unchanged`
  - `no adapter reads process.env`: a source scan of `src/discord`, `src/coop`, `src/eos`
  - `no Date.now() in the three subpaths beyond the clock default`
- **Run:** `npx vitest run packages/http/test/integrations-cross.test.ts packages/http/test/exports.test.ts scripts/browser-bundle.test.ts`

### Task R: release prep (for the groups that ship)
See the Release section. Changeset, `npm run version`, peer floors, `check:pack` for the new subpaths, smoke. Publishing is the maintainer's.
- **Tests (names):** `manifests: the published set is still the ten, none private`; `the http floor set names @chatwarden/http (and store-memory and store-sqlite only in the release that carries cw.links)`; `publish-order is unchanged`; `check-pack: @chatwarden/http/discord, /coop and /eos resolve from the packed tarball under ESM and under CommonJS with moduleResolution node; the root still does not export them`; `smoke: the consumer projects install and a consumer imports each shipped subpath`; `changelog: the new subpaths and the @chatwarden/discord components option are named`.
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/publish-order.test.ts scripts/release-workflow.test.ts scripts/changelog.test.ts scripts/sync-version.test.ts scripts/check-pack.test.ts scripts/smoke.test.ts packages/http/test/cjs-types.test.ts`

---

## Release

**What ships:** a patch (the number is assigned in merge order) of the ten packages in the fixed group, carrying one, two or all three integrations. **No new package**, so the OIDC publish
path is unchanged and the owner has no first publish to do (RELEASING.md, "New packages: the first publish" does not apply). A release that carries `cw.links` includes one additive SQLite migration: a database
opened by that release is readable by the one before. A release that carries only the Discord bot has no migration.

### Before the tag (all in the branch)
1. `npx changeset`: patch for the group. First line names what the release carries ("adds a Discord bot, a Coop adapter and an EOS adapter" or the subset). Then plain sentences: the subpaths (`@chatwarden/http/discord`, `@chatwarden/http/coop`,
   `@chatwarden/http/eos`), the `components` option of `discordFeed`, `cw.sanctions.byRef` and `cw.links` where they ship, the migration number where it ships, the `@experimental` names, that none is on by default.
2. `npm run version` (bumps the ten, runs `sync-version`, refreshes the lockfile).
3. **Peer floors, by hand.** `@chatwarden/http` peers on core at the release that ships `byRef` (Group D) and `links` (Groups C and E): set its `peerDependencies["@chatwarden/core"]` to that version and update the expectation in
   `scripts/manifests.test.ts` in the same commit, naming the API in the changeset. `store-memory` and `store-sqlite` rise to it in the release that carries `cw.links` (they implement the new store methods). `@chatwarden/discord` keeps `^0.1.0`.
   Never raise a floor to the current version just because the group moved.
4. `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs`.
5. A dry run: `gh workflow run release.yml -f dry_run=true --ref k5`.
6. Merge when CI is green. **Tag and push only on the maintainer's go-ahead.** The release publishes the ten through OIDC with provenance.

### What the adopter does (not part of the tag)
Opt in, per integration, as the READMEs say; nothing is on by default. Discord: create the application and the application-owned webhook, mount `bot.routes`, pass `bot.components` to the feed, run `registerCommands` once. Coop: create the item types,
policies and actions from `setup.checklist()`, mount `coopAdapter.routes`, call `sweep()` at start. EOS: allow the client policy actions, provide `productUserIdsOf` and `seatOf`.

### Site and announcement
No site change. After a release is on npm and the live checks have run, a short "Integrations" paragraph for the README and the site's FAQ (a follow-up in `docs/plans/follow-ups.md`).

---

## Spec coverage (self-review)
Design 1 to 3 to the Goal and Global Constraints; 4 to the fakes (each fake implements the documented wire format strictly) and the manual tasks D10, C8, E5; 5.1 to A2; 5.2 to A1; 5.3 to D4, D5, C3; 5.4 to A4 and X1; 5.5 to X1;
6.1 to D3 and D5; 6.2 to D1, D2 and D10; 6.3 to D1 and D2; 6.4 to D3; 6.5 to D3, D4, D5, D6; 6.6 to D4, D5; 6.7 to D4, D5 and X1; 7 to D2, C2, C3, E2; 8.1 to C1; 8.2 to C3; 8.3 to C1 and C2; 8.4 to C3; 8.5 to C4; 8.6 to C1 and C2;
8.7 to C5 and C6; 9.2 to E1; 9.3 to E2; 9.4 to E3; 9.5 to E4 (docs); 10 to the Global Constraints, Review Focus and X1; 11 to the per-task tests; 12 to Review Focus and the manual tasks; 13 to the plan's omissions; 14 to R and the docs tasks;
15 to D10, C8 and E5. Every name used in more than one task (`decideAs`, `createDeliveryQueue`, `LinkRow`, `byRef`, `kitRoleOf`, `encodeCustomId`, `buildReport`, `decisionOf`, `verifyCoopSignature`, `createTokenSource`, `discord-world`, `coop-world`, `eos-world`)
is defined once in its owning task and consumed under the same spelling.
