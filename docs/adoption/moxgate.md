# Moxgate adoption inventory for the Chatwarden kit (K6 input)

Date: 2026-11-09. Read-only research. Nothing was edited or run (no test suites, no installs).

Sources read:
- Moxgate: `C:\dev\moxgate` (branch `main`, HEAD 4885e6c0a6, working tree has uncommitted `.claude/memory/*.md` only).
- Kit: `C:\dev\chatwarden-wt\k3b` (branch `k3b-http`, HEAD 6573225). The kit worktree `node_modules/@chatwarden/` has no `discord` symlink (core, example-tiny-chat, http, matcher, profanity, store-sqlite only), so the workspace needs a re-`npm install` before the discord package can be used locally. `packages/discord/dist` exists.

Path convention: `M:` = `C:\dev\moxgate`, `K:` = `C:\dev\chatwarden-wt\k3b`. Line numbers are from the files as read.

Important status fact: the Moxgate 11-09 spec (`M:docs/superpowers/specs/2026-11-09-mod-triage-actions-notices-design.md`, same content as the kit's `K:docs/design/2026-11-09-feature-contract-from-moxgate.md`) is NOT implemented in Moxgate. Evidence: `M:server/accounts/migrations.ts` ends at version 33 (lines ~685-692); a grep for `mod_notices`, `communityRules`, `mod_report_reads` in `server`, `src`, `cloudflare` finds nothing. So Moxgate has no warnings, notices, Community Rules, ref codes or AI read today. All of those arrive with the kit as NEW player/mod-visible behaviour.

---

## 1. Moxgate's current moderation surface

### 1.1 Runtime shape and kill switches

- One relay process (Express 5 + `ws`), on box 1 only. Other boxes are `forge-host` (Java) shards, which hold no moderation state (`M:deploy/ovh/docker-compose.shard.yml:22`). So in-memory indexes are single-process and correct.
- `installModeration` (`M:server/moderation/wire.ts:247-310`) is the single boot call; it is fail-soft: any throw logs the error class, clears the hasher, returns undefined, leaving the original chat path (wire.ts:303-308). Called at `M:server/index.ts:2285-2286` (not under `NODE_ENV=test`), synchronous, at module top level. Teardown `moderation?.stop()` at index.ts:3019; seed-retry tick at index.ts:2928.
- Kill switches: `CHAT_MODERATION=off` (no runtime at all, wire.ts:76-80); `MOD_SANCTIONS=off` (sanction index answers "nothing active", slurs still blocked, strikes still recorded, reports/mutes still work; read per call, wire.ts:102, sanctions.ts:82-91); `MOD_KEY_SECRET` unset (no hasher: reports, mutes, browser/IP sanctions OFF; only slur blocking + account sanctions work; wire.ts:82-86, 142-146); `CHAT_GATE_OPEN_TABLES=signedIn` (chatGate.ts:11-14).
- Other env: `MOD_ADMIN_TOKEN`, `DISCORD_REPORTS_WEBHOOK`, `DISCORD_MOD_GUILD_ID` (wire.ts:113, 159-170; memory `chat-moderation.md` "Env").

### 1.2 Chat pipeline order (the real order of a chat line)

`handleChat` at `M:server/moderation/chatPipeline.ts:66-158` (header comment 1-11):

1. WS frame validated upstream (prelude `validate`, `M:server/wsMessageHandler.ts:1141-1146`); `lang` kept only if it matches `CHAT_LANG_RE` (chatPipeline.ts:50, 99).
2. Team audience: `scope:'team'` resolved via `teamChatRecipients` (`M:server/teamChat.ts`); no team => `chat_rejected{reason:'team'}` BEFORE moderation, spends no rate budget (chatPipeline.ts:82-88).
3. Moderation off (`!rt || !rt.enabled`): legacy path `chatMod.process` then broadcast (lines 104-123).
4. Signed-in gate: `rt.chatGateFor(room)==='signedIn' && !room.seatAccounts.has(playerId)` => `chat_rejected{gate}` (125-128).
5. Restriction: stored `chat` or `ban` sanctions via `SanctionIndex.active`, plus the in-memory automatic restriction; longest wins, permanent beats timed; `byModerator = kind==='ban' || !auto` (130-136, 182-204).
6. `ChatModerator.process` (`M:server/chatModeration.ts:40-55`): trim; empty (silent); length > 200; sliding-window rate 3 per 5000 ms keyed `room.code:playerId` (consts 5-7, 25); slur matcher AFTER the rate check, so a blocked line spends budget (47-50); then `obscenity` English profanity starred with `TextCensor()` default strategy = grawlix (24, 52-53; obscenity's `TextCensor` default is `grawlixCensorStrategy`, `node_modules/obscenity/dist/censor/TextCensor.js:11`).
7. On `blocked`: line buffered as evidence with `blocked:true`, strike recorded, maybe auto-timeout (142-148, 208-240); sender gets `chat_rejected{blocked}` only (term id never leaves).
8. Delivered line is buffered (`rt.buffers.append`) and gets a `lineId` (151).
9. Delivery per recipient, skipping seats that muted the sender (`mutedFilter`, 253-265, loop 154-157). A failed mute lookup delivers.
- Typing (`handleTyping`, 160-177): gated by signed-in gate, active restriction and mutes; never buffered.
- Refusal frame: `chat_rejected` reasons `empty|length|rate|team|blocked|gate|restricted` + `until` + `byModerator` (`M:server/protocol.ts:784`).

### 1.3 Persistence: exactly where

Engine: **SQLite via `node:sqlite` `DatabaseSync`**, one file. `M:server/accounts/db.ts:1,27-28`. Path: `${ACCOUNTS_DIR || PERSIST_DIR/accounts}/accounts.db` (db.ts:9-16); prod `ACCOUNTS_DIR=/data/accounts` (`M:deploy/ovh/docker-compose.yml:371`). Pragmas: WAL (non-memory), `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` (db.ts:30-33). Schema versioned in its own `meta` table key `schema_version` (db.ts:34-49), migrations applied in one `BEGIN IMMEDIATE` (db.ts:39-45).

Not Postgres, not D1, not Durable Objects for moderation: not found. (Cloudflare D1 in `M:cloudflare/cards-api/wrangler.toml:29` is card data; the Worker's only chat-related piece is `/translate`.)

All moderation tables are created in one migration, **version 29** (`M:server/accounts/migrations.ts:511-638`, "amended in place pre-ship" per memory), plus version 33 columns (lines ~685-692). Ids are random 16-byte base64url, times are epoch ms, booleans 0/1.

| Table (line of CREATE) | Columns |
|---|---|
| `mod_reports` (512) | `id` PK, `created_at`, `room_code` NOT NULL, `game_id` (always NULL: reports.ts:173), `format`, `reporter_seat/handle`, `reporter_key` NOT NULL, `reporter_account`, `reporter_ip`, `reported_seat/handle`, `reported_key` NOT NULL ('' when keyless), `reported_account`, `reported_ip`, `category` NOT NULL, `note`, `line_id`, `excerpt_json`, `status` CHECK open/actioned/dismissed default open, `mod_note`, `actioned_by`, `actioned_at`, `UNIQUE (reporter_key, reported_key, room_code)`; v33 adds `people_json` (JSON `[{seat,handle,key,account,ip}]`) and `bad_faith` 0/1 plus reporter indexes. Indexes by reported_key, reported_account, status, created. |
| `chat_mutes` (542) | `viewer_key` NOT NULL ('' = none), `viewer_account`, `target_key` NOT NULL ('' = none), `target_account`, `created_at`. No PK / no UNIQUE on purpose (mutes.ts:277-278 in the original numbering; comment "the table has no UNIQUE constraint on purpose"). Indexes viewer_key, viewer_account, created_at. |
| `chat_strikes` (552) | `id` PK, `at`, `player_key` NOT NULL, `account_id`, `ip_hash`, `room_code`, `term_id`. Indexes (player_key, at), (at). |
| `mod_sanctions` (563) | `id` PK, `kind` CHECK chat/open_table/ban, `target_type` CHECK account/key/ip, `target_value`, `starts_at`, `ends_at` (NULL = permanent), `reason`, `moderator` NOT NULL, `auto` 0/1, `revoked_by`, `revoked_at`, `revoke_reason`, `group_id` NOT NULL. One row per identifier, tied by `group_id` (sanctions.ts:5-8, 29-63). |
| `mod_notes` (581) | `id`, `subject_key` NOT NULL ('' for account notes), `subject_account`, `body`, `moderator`, `created_at`. |
| `mod_terms` (592) | `id` PK, `term`, `language`, `active`, `note`, `added_by`, `added_at`, `updated_by`, `updated_at`, `UNIQUE (term, language)`. |
| `mod_term_exceptions` (604) | same shape with `phrase` instead of `term`, no UNIQUE. |
| `mod_audit` (615) | `id`, `at`, `actor`, `action` (add/edit/disable/enable), `subject` ('term:<id>' / 'exception:<id>'), `before_json`, `after_json`. Written only by the term store (termsStore.ts:232-244). |
| `mod_threads` (624) | `subject_account` ''/id, `subject_key` ''/key, `thread_id`, `last_bot_message_id`, `last_posted_at`, `created_at`, PK (subject_account, subject_key). Special row `subject_key='__terms__'` (wire.ts:36, discordFeed.ts:20). |

In-memory only (lost on restart, by design): evidence buffers `ChatBuffers` (100 lines / 15 min per room; `M:server/moderation/chatBuffer.ts:8-9`, append 53, prune 85; dropped on room destroy/cool wire.ts:138-140); `SanctionIndex` (loaded from DB at boot and after every write, sanctions.ts:76-127); `strikesMem` and `memRestrictions` maps (chatPipeline.ts:34-38, strikes.ts:68-85); the sliding-window rate limiter buckets (`M:server/rateLimit.ts:43-63`); per-seat IP hash `room.seatIpHash` (`M:server/index.ts:286-296`, "never persisted"); last-sent muted-seat list per socket (reports.ts:251); Discord feed's serial tail promise (discordFeed.ts:138).

Retention (hourly, plus once at boot; wire.ts:194-228, 277-284): reports 90 d, strikes 90 d, notes 365 d, mutes 180 d, sanctions 90 d after end (or after revoke if permanent), audit 365 d, threads 90 d idle (the `__terms__` thread is exempt).

Backups: `accounts-backup.sh` hourly "core" = every table except the telemetry list `matches match_logs match_features` (`M:deploy/ovh/backup/accounts-backup.sh:60,126`), so `kit_*` tables would be backed up automatically.

### 1.4 Identity model

- Hasher: `makeHasher(secret)` = HMAC-SHA256 over `"<kind>:<input>"`, first 32 hex chars, kinds `playerKey` and `ipHash` (`M:server/moderation/identity.ts:24,26-37`). Secret = `MOD_KEY_SECRET` (wire.ts:82). Global setter/getter (identity.ts:43-49) because the WS upgrade reads it per upgrade (index.ts:1943-1951).
- Guest = a browser `clientToken` (UUID in `localStorage`, `M:src/utils/roomSession.ts:79-91`), registered clientToken->seat in `room.playerTokens`. Signed-in = accounts: `room.seatAccounts` (seat -> account id). The token is a seat credential, so only its HMAC (`playerKey`) is stored.
- `Identity = {playerKey, accountId, ipHash}` (identity.ts:11-15). `seatIdentity` (56-67): AI/host-controlled seats are all-null; accountId is reported even without a hasher.
- IP: the hashed address of the seat's socket, recorded at WS attach by `recordSeatIpHash` (index.ts:286-296) using `getUpgradeOrigin` (rightmost `x-forwarded-for` hop, else socket address; index.ts:233-282); `'unknown'`/none is never hashed.
- `sameIdentity` (identity.ts:90-94): equal account OR equal key; deliberately never IP. Used for self-report, self-mute, mute matching (SQL `MATCH_SQL`, mutes.ts:25). No transitive subject graph: each lookup is a one-hop OR match, and mod-applied sanctions add every account/key "seen together" in reports/strikes (`linkedOf`, modAdminRoutes.ts:312-326, `SIGHTINGS` 112-125).
- Doors take the same three identifiers via `identityFromUpgrade` (identity.ts:74-85), `DoorWho` (enforcement.ts:8-9).

### 1.5 Sanctions, strikes, mutes, doors

- Kinds `chat | open_table | ban`; durations `1h 24h 7d 30d permanent` (modAdminRoutes.ts:34-37). IP row capped at 24 h (sanctions.ts:16, 43). Group revoke keeps first revoker (67-70).
- Auto timeout: 3 blocked lines inside 1 h => 30 min chat restriction; another within 7 days of the last automatic one => 24 h; strikes are "consumed" by the restriction they trigger (strikes.ts:9-13, 30-85). DB path needs a DB and a `playerKey`; else an in-memory tally keyed by `room:seat`, first-penalty only (strikes.ts:68-85, chatPipeline.ts:219-233). Reason string `auto: repeated slurs`, moderator `auto` (chatPipeline.ts:52, 224).
- Mutes: 180 d TTL from `created_at` (refreshed on re-mute), cap 500 per viewer (oldest dropped), either side matched by key OR account, no-op if either side has no identity or it is self (`M:server/moderation/mutes.ts:10-11,30-68,74-85`). The relay tells the viewer its muted seats with `chat_muted_seats` on attach, on mute, and on seat changes (`reports.ts` sendMutedSeats 268-275, refreshMutedSeats 279-289, handleChatMute 293-308; index.ts:1727, 1970-1973).
- Doors (`M:server/moderation/enforcement.ts`): `makeDoorCheck` refuses `open_table` or `ban` (public tables, Quick play, ranked queue; line 39); `makeBanCheck` refuses `ban` only (join, claim seat, create room; line 45); WS upgrade `banFor` -> `error BANNED` (index.ts:1885-1895). Wiring: index.ts:1734-1736, lobbyRoutes.ts:45, roomRoutes.ts:64, queue/routes.ts:6, trusted/gate.ts:4.

### 1.6 Reports

`handleReport` (`M:server/moderation/reports.ts:138-229`). Refusal order: `off` (no runtime / no db / no hasher / reporter has no `playerKey`, line 152), `not_player` (target has neither key nor account), `self`, `suspended`, `rate`, `duplicate` (UNIQUE violation). Limits: 10 reports per reporter key per 24 h; 3 bad-faith dismissals in 30 d suspend (reports.ts:21-26, 120-134, 203-205). The target is the author of `lineId` if still buffered (even if the seat changed hands), else the seat's occupant (156-159). The excerpt is the room's whole evidence snapshot with identities stripped (167-168) and `people_json` keeps one identity per chatter (170). Categories `harassment hate cheating spam disruption other` (`M:server/protocol.ts:369`), note <= 500 (REPORT_NOTE_MAX, protocol.ts:372). `onReport` hook fenced after the ack (224-228). Counts for the Discord post: reports/tables/auto-restrictions in 7 days (233-247).

### 1.7 Slur term list and its storage

- Matcher: `obscenity` `RegExpMatcher` with `englishRecommendedTransformers`; each active term compiled as whole-word pattern `|word|` with repeated-letter collapsing that mirrors the preset (`M:server/moderation/slurMatcher.ts:27-48,159-181`); `stripInvisible` NFKD + remove `\p{M}`, `\p{Cf}`, blank fillers (51-53); a second pass with `! | ( / $ @` turned into spaces (156-157, 183-197); word-bounded exceptions done in code, not obscenity's whitelist (141-153). Min 3 letters after collapsing, plain letters only (40, 65-83).
- Seed: `HATE_TERMS_SEED` (typed en/es/pt; `M:server/moderation/hateTermsSeed.ts:21`) and `HATE_TERM_EXCEPTIONS_SEED` (122, other languages appear in exceptions); ids `seed:<lang>:<i>` / `seed-ex:<lang>:<i>` (slurMatcher.ts:204-223). Test corpora `hateTermsCorpus.ts` (POSITIVE/NEGATIVE/KNOWN_LOSSES).
- Storage: DB rows are truth after first boot; `seedTermsOnce` fills each EMPTY table once (`M:server/moderation/termsStore.ts:42-58`); `LiveSlurMatcher` rebuilds on every edit and keeps the previous matcher on a failed build; a first-load failure falls back to the compiled seed and `makeSeedRetry` retries every 60 s (termsStore.ts:85-136, wire.ts:41, 176-192).
- Edit safety: `applyTermChange` = SAVEPOINT + reload + "exception would unblock" canary over POSITIVE_CORPUS, rolled back on any failure (termsStore.ts:167-220); `checkTermHits` dry run against NEGATIVE_CORPUS + recent delivered lines (143-162); duplicate guard by collapsed key across languages (262-271); every edit audited (232-244).
- Names/UGC use the same live matcher: `nameCheck.ts` (`nameViews` 13-20 underscore/camelCase/digit views, `nameIsBlocked` 49, `textIsBlocked` 55, error bodies `NAME_NOT_ALLOWED`/`TEXT_NOT_ALLOWED` 82-83, `refuseBlockedName` 86); doors: accountRoutes.ts:19, lobbyRoutes.ts:46, roomRoutes.ts:65, draft/draftRuntime.ts:26, customCards/derive.ts:10, accounts/sharedDecks.ts:7, `gameText.ts:4,48`. One-time cleanup script `auditNames.ts`.

### 1.8 Admin / mod routes and auth

Relay: `mountModAdminRoutes` (`M:server/moderation/modAdminRoutes.ts:192`), prefix `/api/admin/mod` (30), mounted only with a DB and `MOD_ADMIN_TOKEN` (wire.ts:159). Auth, two gates (lines 199-208): (1) a request carrying `x-forwarded-for` => 404 (loopback only); (2) `Authorization: Bearer $MOD_ADMIN_TOKEN` compared with `timingSafeEqualStr` (`M:server/bugReportRoutes.ts:1039`), 503 `ADMIN_DISABLED` without a token, 401 otherwise. Every write needs `x-mod-actor: <email>` (regex `ACTOR_RE`, 48, check 211-218) except `/test`. JSON body limit 64 kB. The relay has NO roles: one token = full power. Roles live in moxops (`M:deploy/ovh/ops/src/roles.ts`, `OPS_OWNER_EMAILS`/`OPS_MODERATOR_EMAILS`, Cloudflare Access), which proxies `/mod/*` to the relay (`M:deploy/ovh/ops/src/modRoutes.ts:72-96`, `modClient.ts`). The hub UI is `M:deploy/ovh/ops/ui/src/moderation/*` (~4.1k lines of tsx).

Routes (all under `/api/admin/mod`): `GET /queue` (224, grouped by reported player), `GET /reports/:id` (264), `POST /reports/:id/status` (290; `actioned|dismissed`, required note, optional `badFaith`), `GET /history` (374), `POST /sanctions` (436; subject `a:<id>`/`k:<key>`, kind, duration, reason, includeIp, force; 409 `UNKNOWN_SUBJECT` unless history exists; targets = subject + all linked accounts/keys), `POST /sanctions/:groupId/revoke` (470), `POST /notes` (493), `GET /terms` (522), `POST|PATCH /terms[/:id]`, `POST /terms/:id/active`, same for `/exceptions` (580-636; a term add runs the hits dry-run: 409 `HITS` unless confirmed), `POST /test` (639; verdict blocked/starred/clean/too_long), `GET /blocked` (651), `GET /audit` (691), `GET /recent` (710).

### 1.9 Discord feed

- Webhook (not a bot): `makeForumClient(url)` — open thread, post, edit own message, 10 s timeout, never throws, never logs the URL (`M:server/moderation/forumClient.ts:1-60`, THREAD_NAME_MAX 100, CONTENT_MAX 2000).
- `ModerationFeed` (`M:server/moderation/discordFeed.ts:136`): one forum thread per reported person (account match wins, else key; `find` 263-275), title `<Category> · <masked handle>` (81-84), events `onReport` (147), `onAutoRestrict` (161), `onSanction` (171), `onRevoke` (185), `onReportStatus` (194), `onTermChange` (215, standing "Slur list changes" thread, 19-21). Reports within 10 min of the last real post edit that post (COALESCE_MS, 24; deliver 312-332). Posts carry hub deep links `https://ops.moxgate.com/#moderation/...` incl. one-click prefilled actions (HUB_BASE 17, actionLinks 42-55). The handle is shown (masked by the slur matcher, 73-78); no chat text, no reason, no keys. An "Active: chat restriction until <t:...>" line is appended (240-261). A thread Discord says is gone is re-opened once (326-330). Serial queue (224-237).
- Wiring: `rt.onReport`/`rt.onAutoRestrict` fenced via `fire()` (wire.ts:60-66, 131-134).

### 1.10 Client UI pieces

- `M:src/components/ChatPanel/`: `ChatPanel.tsx` (461 lines; composer maxLength 200 at line 424; restricted/gated/blocked composer notices 383-398; typing indicator 60-66, 299-311; muted rows 327-335; per-line `ChatLineText` with translation 78-110; `ReportDialog` mount 444-447), `ChatLineMenu.tsx` (Mute + Report menu, 109 lines), `ReportDialog.tsx` (169 lines: six categories, 500-char note, "Also mute this player" default on, standing false-report warning, waits for `report_ack` with a 10 s timeout; REFUSAL_KEY map 19-27), `reportEligibility.ts` (`canReportSeat`), `useChatActions.ts`/`ChatContext.tsx`, `teamChat.ts`, `useTeamChatAvailable.ts`, `chatCompact.ts`.
- Store: `src/store/slices/chatSlice.ts` (`chat_rejected` handling line 38+, `activeChatRestriction`, `effectiveMutedSeats`); WS decode `src/hooks/useMultiplayer.ts:1614`.
- Strings (en-US `M:src/i18n/overlays/en-US/board.json:86-136`): `chatRateLimited` "Sending too fast. That last message was not sent.", `chatTooLong` "That message was too long to send.", `chatTeamUnavailable`, `chatModeration.restrictedUntil` "You can't chat until {0}.", `restrictedForever` "You can't chat in games anymore.", `restrictedByMod` "A moderator restricted your chat.", `gated`, `blocked` "That message wasn't sent: it contains a slur.", `banUntil`/`banForever`, `openRestrictedUntil/Forever`, report-dialog copy (`reportSent` "Thanks. Moderators will review it.", `refuse*`, `reportFalseWarning`). Name/text refusals in `gameplay2.json:87-88`. Six locales (de-DE, en-US, es-ES, fr-FR, it-IT, pt-BR).
- No notice dialog, no "My record", no warning ack: not found.
- Translation: `M:src/services/chatTranslation/chatTranslation.ts` + `engines.ts` (Chrome on-device `Translator` first, then the Cloudflare fallback; per-viewer; "show original"). Edge: `M:cloudflare/cards-api/src/translateRoute.ts` — `POST /translate {text,from,to}`, the app's 6 languages only, 200-char cap, 2048-byte body, Workers AI `@cf/meta/m2m100-1.2b`, edge cache keyed by sha256 of the text, per-IP rate limit binding `TRANSLATE_LIMIT`, 503 if no AI binding (translateRoute.ts:17-23, 69-105). Moderation always runs on original text (the relay never sees translations).

---

## 2. Mapping matrix

Status legend: **Covered**; **Partial** (what is missing); **Not in kit** (phase); **Glue** (Moxgate-specific, stays).
Kit phases from `K:docs/design/2026-11-09-product-scope.md` (roadmap table at the end): K3c AI read, K4 hub UI + player UI, K4c chat layer/translation, K4b init/service/testing kit, K5 Coop/Discord bot, K6 Moxgate adopts, K7 corpus, K9-K14 later.

| # | Moxgate behaviour (file:line) | Chatwarden equivalent (package + API) | Status |
|---|---|---|---|
| 1 | HMAC hasher, playerKey/ipHash (`identity.ts:24-37`) | `@chatwarden/core` `makeHasher`/`hashWho` (`K:packages/core/src/hasher.ts`), byte-compatible, same `playerKey`/`ipHash` kind strings | Covered. Requires the SAME `MOD_KEY_SECRET` value. Method names differ (`clientKey`/`ip`). Kit throws on an empty secret (no "keys off" degrade mode). |
| 2 | Identity per seat, `seatIdentity`, `sameIdentity` (`identity.ts:56-94`) | `cw.rooms.seat(roomId, seatId, rawWho, handle, tags)`, `seatConnection`, `unseat`, `close`, `subjectAt`; `SubjectIndex` (`K:packages/core/src/subjects.ts`) | Partial. The kit links key+account into one persistent subject and MERGES subjects transitively (older survives); Moxgate was a one-hop OR match with no merge. The kit does not link IP (same as Moxgate). Glue needed: call `rooms.seat` at every attach/takeover/seat_moved, `unseat` on free/kick, `close` on room destroy/cool (replaces `onRoomDestroyed`/`onRoomCooled`, wire.ts:138-140). |
| 3 | Evidence buffer 100 lines / 15 min (`chatBuffer.ts`) | `EvidenceBuffer`, `RoomRoster` (`K:packages/core/src/evidence.ts:8-9`, same 100 / 900 000) used inside `cw.chat.accept` | Covered. |
| 4 | Chat pipeline `handleChat` | `cw.chat.accept(roomId, seatId, text, {audience?})` -> `{deliver:{lineId,text}} \| {refuse:{reason,until?,byModerator?,rule?,noticeId?}}` (`K:packages/core/src/chat.ts:26-29,230`) | Partial. Order is the same except: the kit does the empty check BEFORE gate/restriction (Moxgate: after), and a gate failure also fires for an unknown/empty seat. The kit lacks the team-audience refusal, `lang` relay, typing and per-recipient broadcast: those stay glue. |
| 5 | Team audience (`chatPipeline.ts:82-88`, `server/teamChat.ts`) | `accept(..., {audience: seatIds[]})` records it on the evidence line; `visibleTo` | Glue for roster/team resolution and delivery; the kit covers recording `audience` (string[] seat ids, vs Moxgate `'table'`/`'team:<n>'`). |
| 6 | Signed-in chat gate (`chatGate.ts`, `chatPipeline.ts:125-128`) | `ChatwardenOptions.gate(roomId, subject)` | Partial. The hook receives a subject, not the seat, so `room.seatAccounts` is not reachable from it. Do the gate in glue BEFORE `accept` (spends nothing, same as today). `CHAT_GATE_OPEN_TABLES`, the host setting and the `room_chat_gate` frame stay glue. |
| 7 | Length 200 / rate 3 per 5 s (`chatModeration.ts:5-7`) | `limits.chatMaxLength`, `limits.chatRate` (`K:packages/core/src/limits.ts`; defaults 200, 3/5000) | Covered; same key shape `roomId:seatId`. |
| 8 | Slur matcher (`slurMatcher.ts`) | `@chatwarden/matcher` `buildMatcher`, `stripInvisible`, `foldTerm`, `collapseLikePreset` (`K:packages/matcher/src/matcher.ts`, `normalise.ts`) | Covered by structure (same LEET pass, same `isExcepted`, MIN_TERM_LENGTH 3: matcher.ts:45, 99, 114-115). Parity not verified: run Moxgate's `slurMatcher.test.ts` + `hateTermsCorpus.ts` against it. |
| 9 | Live term list in DB + edit safety (`termsStore.ts`) | `LiveTerms` + `TermStore` (`K:packages/matcher/src/liveTerms.ts`), tables `kit_terms`/`kit_term_exceptions`/`kit_audit`; `LiveTerms.check` = hits dry run; seed-once = `TermPack` + `store.isSeeded/markSeeded` | Covered, with a data step: the kit seeds from a `TermPack` (per-term `positive`/`negative` lines, `loadTermPack`) once per pack id; for Moxgate use migrated rows + `markSeeded`. The seed-fallback retry tick (`makeSeedRetry`) was not found in the kit. |
| 10 | Name/UGC check (`nameCheck.ts`) | `cw.names.check(text)`, `matchName`/`nameViews` (`K:packages/matcher/src/names.ts`); HTTP `POST /names/check` (`K:packages/http/src/player.ts:208`) | Covered for names (identical view logic). `textIsBlocked` = `matcher.match` directly. Error bodies `NAME_NOT_ALLOWED`/`TEXT_NOT_ALLOWED`, the memo cache and `refuseBlockedName` stay glue. |
| 11 | Profanity starring (`chatModeration.ts:20-24,52-53`) | `@chatwarden/profanity` `createProfanityFilter` via `ChatwardenOptions.profanityPackage`; profile `profanity.mode/style` | Partial. Same library (obscenity English dataset) but a different mask: kit styles `full`/`keepFirst`/`grawlix` with glyph cycle `#$%@!&` (`K:packages/profanity/src/filter.ts:24`), default `full` (`K:packages/core/src/profile.ts:457-464`); Moxgate uses obscenity's own grawlix. Word-list parity not verified. `wouldStar` for the mod test box has no facade method (build a filter once and call `.apply`). |
| 12 | Active restriction check (`chatPipeline.ts:182-204`) | Inside `accept` (`SanctionIndex.active` + in-memory fallback) -> `refuse.restricted{until,byModerator,rule,noticeId}` | Covered. There is no public "is this seat restricted" for typing: typing suppression for restricted seats is **Not in kit** (K4c chat-server). |
| 13 | Sanctions group/index/revoke (`sanctions.ts`) | `applySanction`/`revokeSanction`/`SanctionIndex` + `cw.sanctions.apply/revoke` (`K:packages/core/src/sanctions.ts`) | Covered with changes: kinds `chat\|area\|ban\|warning\|note` (`open_table` becomes `area`); one subject row + at most one IP row per group (Moxgate: a row per account and per key); mandatory `reason`, `rule`, `source`, `actor`; ref code `M-XXXXX` (sanctions.ts:105-109); max timed 365 d (sanctions.ts:18); IP cap 24 h kept. |
| 14 | Strikes + automatic timeout (`strikes.ts`) | `StrikeService` (`K:packages/core/src/strikes.ts:15-27,58`), `limits.strikes` | Covered; same 3 / 1 h / 30 min / 24 h / 7 d constants. The keyless/DB-less in-memory fallback exists in the kit (`memRestrictions` in chat.ts). Retention default for strikes 30 d (Moxgate 90 d). |
| 15 | Mutes (`mutes.ts`) | `MuteService`, `cw.mutes.set/mutedSeats`, `cw.chat.visibleTo` (`K:packages/core/src/mutes.ts:13,16`) | Covered (180 d, 500 cap identical). `chat_muted_seats` frames + refresh-on-seat-change (`reports.ts:268-308`) stay glue using `mutedSeats`. |
| 16 | Doors (`enforcement.ts`) | `cw.doors.check('join'\|'create'\|'public'\|'matchmaking', rawWho)` (`K:packages/core/src/doors.ts`) | Covered: same split (join/create = ban only; public/matchmaking = area+ban). The refusal adds `refCode`, `noticeId`. The WS-upgrade `BANNED` error frame and HTTP 403 codes stay glue. |
| 17 | Reports intake (`reports.ts`) | `cw.reports.submit({roomId, reporterSeat, targetSeat, category, note, lineId})` -> `{ok, reportId, remaining}` or `{refused}` (`K:packages/core/src/reports.ts:44-61`) | Covered (same refusal set, 10/day, 3/30 d). Differences in section 5. |
| 18 | Bad-faith suspension (`reports.ts:120-134`) | `ReportService` + `kit_reports` partial index `kit_reports_bad_faith`; bad-faith verdict via `decide` | Covered; the kit demands written evidence (1..500 chars) for bad-faith dismissals. |
| 19 | Mod report status, sanction, notes, history | `cw.decide`, `cw.history`, `cw.suggest`, `cw.reports.list/get`, `cw.gaps`, `cw.audit` (`K:packages/core/src/chatwarden.ts:174-420`) | Partial. The verdict model (`upheld/noted/no_action/bad_faith`), a required Community Rule per action and the ladder suggestion are NEW. Free-form `POST /notes` has no equivalent except a `note` sanction (which the relaxed `repeat` rule counts). |
| 20 | Admin HTTP API (`modAdminRoutes.ts`) | `@chatwarden/http` `adminRoutes`, `toExpress` (`K:packages/http/src/admin/*.ts`, `express.ts:180`): `GET /reports`, `GET /reports/:id`, `POST /reports/:id/suggest`, `POST /reports/:id/decide`, `GET /people/:ref/history`, `POST /sanctions`, `POST /sanctions/:groupId/revoke`, `GET /gaps`, `POST /gaps/:groupId/close`, `GET /policy`, `GET/POST/PATCH /terms...`, `/exceptions...`, `POST /terms/check`, `GET /audit` | Partial. Routes/payloads differ (4.5). **Not in kit**: `GET /blocked` (blocked-attempts list), `GET /recent`, `POST /test` (verdict box), `GET /queue` grouped by player, reporter record view, `a:`/`k:` refs. Hub UI is K4. |
| 21 | Auth: loopback tell + bearer + `x-mod-actor` (`modAdminRoutes.ts:199-218`) | `AdminOptions.authorize(req) -> {actor, role} \| null`; roles `moderator\|senior\|owner`, permission table (`K:packages/http/src/permissions.ts:28-40`) | Glue: write an `authorize` that checks the bearer + loopback tell and maps the moxops role to a kit role (moxops must start passing a role). Permanent ban needs `senior`; `gaps.close` and `settings` owner; `audit.read` senior. |
| 22 | Role allowlists / Cloudflare Access (moxops `roles.ts`) | none (adopter's) | Glue, stays. |
| 23 | Discord feed (`discordFeed.ts`, `forumClient.ts`) | `@chatwarden/discord` `discordFeed(cw, {webhookUrl, hubLink, mentionRoleId?, severeOnly?})` (`K:packages/discord/src/feed.ts`) | Partial. Same webhook + forum + one thread per person + serial queue. Missing: handle in titles (the kit uses random `Case XXXXX`), 10-min edit-in-place coalescing, per-post "N reports from M tables in 7 days" counts, "Active: ... until" line, one-click action links (the kit's `hubLink(kind:'report'\|'person', id)` only), the standing "Slur list changes" thread (no term-change events subscribed). |
| 24 | Retention prune (`wire.ts:194-228`) | `cw.purge()` + built-in timer via `retention` option (`K:packages/core/src/retention.ts:30-37,128-153`) | Covered. Differences: strikes 30 d, no `mod_notes` purge, `kit_discord_threads` not purged, floors enforced. |
| 25 | Kill switches `CHAT_MODERATION`, `MOD_SANCTIONS` | `ChatwardenOptions.enabled()` (one switch) | Partial. The kit's `enabled=false` turns off BOTH sanction enforcement AND report intake (`reports.ts:184`, `sanctions.ts:362`); Moxgate's `MOD_SANCTIONS=off` left reports/mutes working. `CHAT_MODERATION=off` stays glue (do not construct the kit). |
| 26 | Fail-soft boot (`wire.ts:247-310`) | `createChatwarden` is `async` and throws on bad config (`K:packages/core/src/chatwarden.ts`) | Glue. Moxgate's boot is synchronous at module top level in a CJS file (index.ts:2285). Needs an async boot with the legacy path as fallback until ready. |
| 27 | Report dialog, line menu, composer notices | `@chatwarden/chat-react` ReportDialog/LineMenu/NoticeDialog | **Not in kit** (K4c). Stays Moxgate. |
| 28 | Chat translation (client services + `translateRoute.ts`) | `@chatwarden/translate` | **Not in kit** (K4c). Stays Moxgate; moderation already runs on original text. |
| 29 | Typing indicator | none | **Not in kit** (K4c chat-server). Glue. |
| 30 | Notices / warnings / My record / ref codes | `cw.notices.pending/ack/record/pendingWarning`, `platform.notify`, `playerRoutes` (`GET /notices`, `POST /notices/:id/ack`, `GET /record`, `GET /rules`, `GET /code-of-conduct`) | NEW to Moxgate; the kit covers the server side; player UI is K4 `player-react` / K4c. |
| 31 | Community Rules, ladder, profiles | `cw.rules`, `cw.profile`, `cw.suggest`, `cw.documents` | NEW to Moxgate; covered in the kit (K2/K3a). |
| 32 | AI read, severity-sorted queue | none | **Not in kit yet** (K3c). Moxgate has none either (spec only). |
| 33 | Moderator hub UI (moxops `ui/src/moderation/*`) | `hub-react` | **Not in kit** (K4). Stays Moxgate; needs an adapter to the kit API. |
| 34 | Hub deep links `a:<id>` / `k:<key>` refs | staff ref (opaque canonical subject ref) | Changes; old Discord links become stale (kit design doc line 215 says the kit replaces these refs). |
| 35 | `auditNames.ts` one-time cleanup | none | Glue (can call `cw.names.check`). |
| 36 | Game text scrubbing `gameText.ts` | none (uses `cw.names.check`/matcher) | Glue. |

---

## 3. Data migration

### 3.1 Engine compatibility: compatible, no new adapter needed

- Moxgate = SQLite through `node:sqlite` (`M:server/accounts/db.ts:1`). `@chatwarden/store-sqlite` `openStore({ db })` accepts a host `DatabaseSync` handle and only touches `kit_`-prefixed tables and its own `kit_meta` key `schema_version` (`K:packages/store-sqlite/src/open.ts:9-13,38-62`; design doc lines 228-232). So the kit can live inside `accounts.db`, using the very handle `openAccountsDb` returns. It sets `foreign_keys=ON` (same as Moxgate) and does not set WAL when it does not own the db (open.ts:45-46).
- Kit tables are included by the existing hourly "core" backup automatically (`accounts-backup.sh:126`).
- A Postgres/Redis store is K14 (product-scope.md), not needed here.
- Wrinkle: the kit needs a store always; Moxgate's "no DB" mode (`db:null`, wire.ts:97-99) has no kit equivalent (use `openStore({path:':memory:'})`).
- Kit migrations (14 versions, `K:packages/store-sqlite/src/migrations.ts`) are additive for Moxgate (`CREATE TABLE kit_*`); v7 and v11 rebuild only `kit_sanctions`.

### 3.2 Table by table

Kit tables: `kit_subjects`, `kit_subject_ids` (v1); `kit_terms`, `kit_term_exceptions`, `kit_audit` (v2, role col v12); `kit_sanctions` (v3, rebuilt v7 and v11); `kit_mutes` (v4); `kit_strikes` (v5); `kit_reports` (v6, `bad_faith_evidence` v10); `kit_notices` (v8); `kit_decisions` (v9); `kit_webhook_keys` (v13); `kit_discord_threads` (v14).

**Prerequisite for everything: build the subject graph.** Kit rows reference `kit_subjects.id` (`s_<22 base64url>`), not keys/accounts. Build it with union-find over identifiers that co-occur: `mod_reports` (reporter key+account; reported key+account; each `people_json` entry key+account), `chat_strikes` (player_key + account_id), `mod_sanctions` groups (all accounts and keys in one `group_id`), `chat_mutes` (viewer_key+viewer_account; target_key+target_account). Write `kit_subjects` (created_at = earliest first_seen) and `kit_subject_ids` rows `(subject_id, kind in account/key/ip, value, first_seen, last_seen)`; keys are already the HMAC values (copy as-is; the kit's key hash equals Moxgate's playerKey if the secret is unchanged); IPs are stored as hashes (never used to link). Merge risk: the kit merges permanently and transitively, so a single shared browser key between two accounts fuses them; produce a dry-run report of components with >1 account or >3 keys and review before applying.

| Moxgate table | Kit table | Field mapping | Cannot migrate / lossy |
|---|---|---|---|
| `mod_sanctions` | `kit_sanctions` | Group rows by `group_id`. Per group: one `target_type='subject'` row with `target_value` = the group's subject id, plus (if any `ip` row) one `target_type='ip'` row with `target_value` = ipHash; both carry the old `group_id` and a new `ref_code` (`refCode()` format `M-XXXXX`, unique among subject rows). `kind`: chat->chat, open_table->**area**, ban->ban. `starts_at`, `ends_at`, `revoked_by/at`, `revoke_reason` copy. `reason` (Moxgate nullable; kit NOT NULL) = old reason or `''`. `actor` = `moderator`. `source`: `auto=1` -> `auto_filter`, else `moderator`; `automated` = `auto`. `pending` = 0. `rule` = NULL (the kit allows NULL "written before rules existed"). `gap_*`, `room_id` = NULL. | The per-row account/key distinction collapses to one subject row (fine, a subject covers all its linked ids). The kit allows only one subject row per group (partial unique index on ref_code); the admin route always puts linked ids in one group, so this holds for admin sanctions; if a group's identifiers fall into several components, keep the longest-lived and log the rest. Migrate only unrevoked or recent (<= 90 d after end) groups (kit ladder looks back 90 d, `K:packages/core/src/ladder.ts:16`). |
| `chat_strikes` | `kit_strikes` | `id`, `at` copy; `subject_id` = subject of (`player_key`, `account_id`); `room_id` = `room_code` or `''`; `term_id` copy (aligns if term ids are preserved); `raw_line` NOT NULL = `''` (Moxgate never stored the line). | `ip_hash` dropped (the kit never keys strikes by IP). Only the last 1 h counts, and the 7-day escalation anchor comes from `kit_sanctions` (`loadAutoChatStarts`), so strikes older than ~7 d are optional. `strikesMem` is volatile. |
| `chat_mutes` | `kit_mutes` | Resolve viewer and target to subject ids; PK `(viewer_id, target_id)`, `created_at` copy; many Moxgate rows collapse into one (dedupe, keep newest). | Mutes older than 180 d skipped (TTL). |
| `mod_reports` | `kit_reports` | `id`, `created_at`, `category`, `note`, `line_id`, `status`, `bad_faith`, `actioned_at/by`, `mod_note` copy. `room_id` = `room_code`. `tags_json` = `{"format": <format>}` (`game_id` always NULL). `reporter_subject` / `target_subject` from (key, account). `reporter_seat/handle`; `target_seat` = `reported_seat`, `target_handle` = `reported_handle`. `excerpt_json`: rename each line's `seat` -> `seatId`, `audience` `'table'` -> `null` and `'team:<n>'` -> `null` (seat list not recoverable), set `p` = `null` on every line. `people_json`: map `[{seat,handle,key,account,ip}]` to an array of subject ids. `bad_faith_evidence` = NULL. | `reporter_ip`, `reported_ip` dropped (the kit stores no IP in reports; the hub's IP-sighting counts `ipSeenWith`/`ipsOf` lose their source). `p` cannot be recovered (Moxgate stripped identities from the excerpt; only seat+handle remain), so notices built from migrated reports fail closed (no excerpt offered), as the 11-09 spec already says for pre-change reports; they purge within 90 d anyway. `UNIQUE (reporter_subject, target_subject, room_id)` may collide where distinct (key,key,room) rows now share subjects: keep the earliest, log the rest. |
| `mod_notes` | **none** | No equivalent table. The closest is a `note` sanction (`kind='note'`), but a note counts toward the profile's `repeat` rule (`K:packages/core/src/ladder.ts:264-266`) and needs a rule. | Recommend NOT migrating into `kit_sanctions`; keep `mod_notes` frozen in Moxgate and let the hub adapter read it (365 d retention keeps pruning it). Owner decision (section 6). |
| `mod_terms` | `kit_terms` | Same columns 1:1: `id`, `term`, `language`, `active`, `note`, `added_by`, `added_at`, `updated_by`, `updated_at`. Keep ids (`seed:en:12`, random ids) so `chat_strikes.term_id` and audit refs still resolve. Then `markSeeded(<pack id>)` so `LiveTerms.load()` does not re-add pack rows (the kit seed also skips an existing id or collapsed word, `liveTerms.ts:257-272`). | The kit drops `UNIQUE (term, language)`; kit uniqueness is by collapsed word across languages (same as Moxgate `assertNotDuplicate`, termsStore.ts:262). |
| `mod_term_exceptions` | `kit_term_exceptions` | 1:1 same columns. | none |
| `mod_audit` | `kit_audit` | `id`, `at`, `actor`, `before_json`, `after_json` copy; `action` map `add` -> `term.add`/`exception.add`, `edit` -> `term.update`/`exception.update`, `enable`/`disable` -> `term.toggle`/`exception.toggle` by `subject` prefix; `subject` `term:<id>` -> `subject_type='term'`, `subject_ref=<id>`; `role` = NULL (v12 column nullable). | The kit audit has a closed action list; only the term store wrote Moxgate audit rows, so nothing is unmappable. |
| `mod_threads` | `kit_discord_threads` | `subject` = subject id (account-or-key row resolved), `thread_id`, `created_at` copy, `label` = new random `Case XXXXX` (the real Discord thread keeps its old name `<Category> · <handle>`). | `last_bot_message_id`, `last_posted_at` dropped (the kit does not edit in place). The `__terms__` standing thread row has no kit counterpart (the kit feed has no term-change thread). |
| in-memory (buffers, `memRestrictions`, rate buckets) | n/a | | Lost at cutover, same as a restart today. |
| `accounts`, `sessions`, etc. | untouched | | |

Count checks (kit design doc K6 step 4: dry run + count check, lines 523-524): compare per-table counts pre/post, plus an equivalence test: for every active `mod_sanctions` group, `cw.doors.check` and `accept` for the matching identifiers must give the same refusal.

### 3.3 Reverse mapping / rollback of data

The cutover is one-way unless the old tables are left intact and untouched (recommended: do NOT drop or rewrite `mod_*`/`chat_*` for >= 90 days). Anything written to kit tables after cutover (new sanctions, mutes, reports) is invisible to a rolled-back old build. Mitigation in section 6.

---

## 4. Runtime compatibility

### 4.1 Facts

- Node: production Docker image `node:24-bookworm-slim` for both stages (`M:deploy/ovh/Dockerfile.relay:13,90`; also asserted by `deploy/ovh/backup/accountsBackupScript.test.ts:35`). The Dockerfile smoke-tests `require('node:sqlite')` (Dockerfile.relay:82-84). Root `.nvmrc` is `22`. No `engines` field in either Moxgate package.json (not found). The kit requires `>=22.13` everywhere (`K:package.json`, every `packages/*/package.json`) and its CI runs 22.13 and 24. **No blocker**: Moxgate already needs unflagged `node:sqlite` (>=22.13), and prod is 24.
- Framework: Express `^5.2.1` + `ws ^8.21.0` + `compression`, `cors` (`M:server/package.json`). Kit `@chatwarden/http/express` targets Express `^5` (optional peer) — compatible. Kit examples use Express + ws (tiny-chat).
- Module system: **mixed**. Root `package.json` has `"type": "module"` (line 5) for the Vite client; the relay is compiled separately by `M:server/tsconfig.json` (`module: CommonJS`, `moduleResolution: node`, target ES2022, `esModuleInterop`, rootDir `..` so `shared/` compiles too; lines 3-13), and `server/package.json` has no `type` => CommonJS. `Dockerfile.relay:99-103` copies `server/package.json` into the runtime image precisely to force CJS for `/app/server/dist/server/index.js`. Dev: `tsx watch server/index.ts`. Prod start: `node server/dist/server/index.js` (Dockerfile.relay:115).
- TypeScript: the server uses `typescript ~5.7.0` (server/package.json) with `strict`, `noUnusedLocals/Parameters`; client tsconfigs use `erasableSyntaxOnly` and reach some server files through tests (memory note: `slurMatcher.ts` had to drop a parameter property because of it, slurMatcher.ts:14). Kit: TS ~5.9, `module NodeNext`, `erasableSyntaxOnly`, `verbatimModuleSyntax` (`K:tsconfig.base.json`).
- Kit packaging: every package is `"type": "module"`, `exports` has only `types` + `default` (no `require` condition), `main` -> `./dist/src/index.js`, `files: ["dist/src"]`, version `0.0.0`, inter-package deps pinned `"0.0.0"` (`K:packages/*/package.json`). `@chatwarden/http` also exports `./express`; `@chatwarden/matcher` exports `./test-fixtures`. `private:false`, `publishConfig.access: public`, not published yet (owner-only step: npm org + publish; memory file last line).
- Test runners: `server/**/*.test.ts` are in the root vitest include (`M:vite.config.ts:250-256`); `server/package.json` still declares jest + ts-jest with `M:server/jest.config.ts` listing six files incl. `index.test.ts`, while a comment in `vite.config.ts` says there is no jest. Unclear which one actually runs `server/index.test.ts`.

### 4.2 Findings and blockers

1. **CJS server consuming ESM-only packages.** At runtime, Node 24 (and 22.12+) can `require()` an ESM graph unflagged if it has no top-level await. I grepped the kit `dist` and found only `await` inside functions (e.g. `chatwarden.js:95-97`), none at top level. So `require('@chatwarden/core')` should work in prod. Not tested here; needs a spike. Risks: (a) a future kit file with top-level await would break it; (b) `tsc` under `module: CommonJS` + `moduleResolution: node` (node10) ignores `exports`: root imports resolve via `main`/`types`, but **subpath imports `@chatwarden/http/express` and `@chatwarden/matcher/test-fixtures` will not typecheck** without `moduleResolution: node16/nodenext`, and under nodenext TS 5.7 reports TS1479 for require() of ESM (accepted from TS 5.8). Options: bump server TS to >=5.8 with `module: nodenext`; or avoid subpath imports (mount routes via the framework-free `createRouter` and write ~20 lines of Express glue); or bundle the kit to CJS for Moxgate; (c) any `await import()` in the server is down-levelled to `require` under `module: CommonJS`.
2. **Jest (if still used) cannot load ESM-only packages** without `--experimental-vm-modules`; `server/index.test.ts` imports `server/index.ts`, which will import the kit. Confirm that file runs under vitest (which handles ESM natively).
3. **Async boot vs sync boot.** `createChatwarden()` is async (loads subjects, sanctions, mutes, strikes before resolving) while `installModeration` is called synchronously at module top level of a CJS file (index.ts:2285). Needs a promise-based boot; until it resolves `wsMessageDeps.moderation` stays undefined (original path). Not a blocker, a design requirement.
4. **Consumption before npm publish.** The kit is a monorepo of 6 packages with inter-deps `"0.0.0"`:
   - `file:` deps to a sibling checkout (`file:../chatwarden/packages/core`): fine for local dev (symlink) but **breaks `docker build`** because the Dockerfile builds from the repo root context (`Dockerfile.relay` header: "Build from the REPO ROOT") and a path outside the context is not copied; the inter-package `0.0.0` deps would also look to the registry unless every package is a root dependency/override.
   - Git dependency: not viable for a monorepo subpackage (npm clones the root, whose `package.json` is the private workspace), and the repo is private (memory: `hainix/chatwarden` private).
   - Vendored tarballs via `npm pack` per package (build first: `npm run build`, `files:["dist/src"]`): commit to e.g. `M:vendor/chatwarden/*.tgz` and reference with `file:vendor/...` plus `overrides` for the inter-package `0.0.0` deps. Works inside Docker context and in CI. **Recommended** until publish. Not verified end to end: do a throwaway `npm install` spike (`.npmrc` has `legacy-peer-deps=true`).
   - Where to declare: runtime resolves from `server/node_modules` and root `/app/node_modules` (Dockerfile.relay:94-98 copies both; `obscenity` is a ROOT dependency, package.json:131). Put kit deps in `server/package.json` (so `cd server && npm install` in Dockerfile.relay installs them) and keep obscenity in root (kit matcher/profanity depend on `obscenity ^0.4.6`, same range as root, so it dedupes).
   - After publish: plain semver deps; remove vendoring.
5. `node:sqlite` handle sharing: kit types come from `@types/node ^22` and Moxgate's server also pins `@types/node ^22.0.0`, so the `DatabaseSync` type is shared; no mismatch expected.
6. Single process only: the kit holds subjects/sanctions/mutes/strikes in memory (Redis/Postgres is K14). The Moxgate relay is single-process on box 1 (shards are Java), so this is fine.
7. Client bundle: Moxgate client `src` tests import some `server/moderation/*` files under client tsconfig (`erasableSyntaxOnly`); once `nameCheck.ts` imports `@chatwarden/matcher`, check that `tsconfig.app.json` / `tsconfig.testcheck.json` resolve it (ESM + bundler resolution, probably fine); `typecheck:crossboundary` and `typecheck:server-tests` (~420 pre-existing errors per memory) need a pass.

Verdict: **no hard blocker on Node version or framework. Real work items: ESM-from-CJS (spike), async boot, vendoring for Docker, TS resolution of subpath exports.**

### 4.3 Release constraints (from `M:.claude/memory/release-process.md`)

Push/merge to origin/main IS the production deploy; never `gh pr merge` in Moxgate; land on LOCAL main and tell the owner. moxgate-3's check does NOT compile the server: run `cd server && npm run build` before any push touching `server/`. No full test suites locally (targeted tests + `npm run gates:quick`). The kit design doc K6 says: ship as one release after a staging soak (`K:docs/design/2026-11-09-chatwarden-design.md:519-527`).

### 4.4 Kit-side prerequisites

- Re-run `npm install` in the kit worktree (discord symlink missing), build all packages (`tsc -b`), then `npm pack` each.
- `LiveTerms` needs a `TermStore` (the `SqliteStore` implements it) and a `TermPack | null`.

### 4.5 API-contract delta for moxops/hub

The hub proxy (`modRoutes.ts:72-96`) and the ~4.1k-line hub UI speak Moxgate's route shapes (`a:`/`k:` subject refs, `/queue` grouped by player, `/reports/:id/status`, `/notes`, `/blocked`, `/recent`, `/test`). Kit routes differ (`/reports`, `/decide`, `/people/:ref/history`, `/gaps`, `/policy`). Until K4 `hub-react` exists, keep Moxgate's `/api/admin/mod/*` as a thin adapter that reads/writes through the kit (and legacy tables where the kit has nothing: notes, blocked list, recent actions, test box).

---

## 5. Behaviour differences visible to players or mods if switched as-is

Player-visible
1. **Profanity mask**: the kit default style is `full` (one `*` per letter); Moxgate shows obscenity's grawlix (doc example `fuck you` -> `%@&* you`). Even `grawlix` in the kit uses a different glyph cycle (`#$%@!&`, filter.ts:24). Word-list parity with Moxgate's `englishDataset` + recommended transformers is not verified.
2. **New refusal fields**: `refuse.rule` (Community Rule number, default CR 1 for slurs), `noticeId`, door `refCode`. The existing UI ignores them, so nothing visible until the client is updated. en-US strings stay as today.
3. **Notices (new)**: a sanction yields a `PlayerNotice` (kind, rule label, until, ref code `M-XXXXX`, up to 5 own lines with matched terms masked, `mustAcknowledge` for warnings). Moxgate players never saw why. A **warning must be acknowledged before the next game** (client-side). Requires UI (K4/K4c or Moxgate-built). Until the UI exists, do not wire `platform.notify` and do not issue warnings via `decide`, else players accumulate unseen notices ("My record" has no screen).
4. **Reporter feedback (new)**: `limits.reporterFeedback` defaults to `true` and creates a `report_outcome` notice for the reporter when a report is upheld with an action (`K:packages/core/src/decide.ts:470`). Moxgate gives reporters nothing today. Turn off with `limits: { reporterFeedback: false }` for parity.
5. **Ref codes (new)**: every sanction group has `M-XXXXX` (alphabet without I L O 0 1, sanctions.ts:50,105-109). Moxgate shows none to players. Mods/Discord quote ref codes instead of `#<first 6 chars of report id>` (`discordFeed.ts:151`).
6. **Restriction-order edge**: an empty/whitespace line from a restricted seat gets no reply in the kit (empty is checked first) but a `restricted` refusal in Moxgate (restriction check precedes `process`). Only reachable by tooling (the client disables Send on empty).
7. **Subject merging**: a browser key used by two accounts (or an account used from two browsers) becomes ONE person in the kit permanently; a chat restriction or mute then follows across all of them, including accounts that were independent under Moxgate's pairwise OR-match. Visible to mods in linked-account counts, to players as a restriction following them to a second account/browser they have linked.
8. **Mutes**: same 180 d / 500 cap; a mute now applies to the target's whole subject (all linked ids); Moxgate matched either id too, so the effect is similar; self-mute rules the same.
9. **Keyless / account-only edge cases**: the kit refuses chat as `gate` for an unknown/empty seat. A missing `MOD_KEY_SECRET` makes `createChatwarden` throw instead of degrading to "slur blocking only". Reports: Moxgate refuses `off` when the reporter has no key (`reports.ts:152`); the kit accepts any reporter with a subject.
10. **Limits unchanged**: 200 chars, 3 lines / 5 s, 10 reports/day, 3 bad-faith/30 d, 3 strikes/1 h -> 30 min, repeat <= 7 d -> 24 h, 180 d / 500 mutes, 100 lines / 15 min evidence, IP rows <= 24 h. All defaults in `K:packages/core/src/limits.ts` equal Moxgate's. Differences: strike rows kept 30 d (was 90 d); `RETENTION_DEFAULTS` otherwise 90 d reports / 90 d sanctions-after-end / 365 d audit.
11. Report refusal reasons: same six (`off not_player self suspended rate duplicate`).
12. **Slur matcher parity risk**: the kit matcher is a re-implementation; any divergence is a player-visible change in what is blocked. Gate: run Moxgate's corpora through it first.
13. Name checks: same logic; the error message and codes remain Moxgate-owned.

Moderator-visible
14. **Different decision model**: verdicts `upheld/noted/no_action/bad_faith` replace `actioned/dismissed(+badFaith)`; every action must cite a numbered Community Rule (or `uncovered` + a gap note); a ladder suggestion line; new kinds Warning and Note; `open_table` is renamed "area". Durations are a free `durationMs` (<= 365 d) rather than the five presets; permanent ban requires role `senior`.
15. **Bad-faith needs written evidence** (1..500 chars); Moxgate needed only the note.
16. **Roles**: the kit has moderator/senior/owner; the Moxgate relay had a single token and moxops two roles. `audit.read` is senior-only; `gaps.close` owner-only.
17. **Discord**: thread titles become `Case XXXXX` and posts carry no handle (Moxgate showed the masked handle); no 10-min edit-in-place coalescing (each report is a new post); no "N reports from M tables in 7 days" or "Active: ... until" lines; no one-click prefilled action links (only report/person links via `hubLink`); no "Slur list changes" thread; `mentionRoleId`/`severeOnly` are new options. Existing threads keep their old names.
18. **Hub deep links**: old `#moderation/player/a:<id>` / `k:<key>` links in past Discord posts stop resolving (kit refs are opaque staff refs).
19. **Lost hub features until K4**: blocked-attempts list, recent actions, "test box" verdict (`starred/clean/blocked`), free-form notes, reporter record panel, queue grouped by reported player and its counts, IP-sighting counts (the kit stores no IP on reports).
20. **Term edits**: same dry-run + canary + audit semantics; the `409 HITS` confirm flow is Moxgate-route specific (the kit returns `{hits}` from `/terms/check`); audit action names change (`term.add` etc.).
21. **Kill switch semantics**: the `MOD_SANCTIONS=off` equivalent now also disables report intake (matrix row 25).
22. **Migrated reports** have `p=null`, so decisions cannot attach "own lines" excerpts to notices for them.

---

## 6. Recommended cut order (small, independently shippable, each with rollback)

Principles: every step lands on LOCAL main and is released by the owner (`ci:release`); each step is test-first with targeted tests only; server changes need `cd server && npm run build`; old `mod_*`/`chat_*` tables stay untouched until the final cleanup (>= 90 days after cutover).

**Step 0. Consumption spike (no behaviour change).** In a throwaway branch: `npm pack` the six packages (after `npm run build` in the kit), add vendored tarballs under `M:vendor/chatwarden/`, declare them in `server/package.json` with `overrides` for the `0.0.0` inter-deps, `require('@chatwarden/core')` from a CJS-compiled server file under tsx and under `docker build` (`Dockerfile.relay`), resolve the TS subpath question (4.2 item 1). Output: go/no-go plus the exact recipe. Rollback: delete the branch.

**Step 1. Hasher + deps landed, kit tables created, nothing reads them.** Add the vendored deps; add a test pinning byte equality of the kit hasher against `identity.ts:26-37` with production-shaped samples (same input and secret => same value); at boot open the kit store on the accounts DB handle (`openStore({db})`) behind an env flag (`CW_KIT_STORE=on`) so tables are created but unused. Rollback: unset the flag; `kit_*` tables are inert and ignored by the old build (`DROP TABLE kit_*; DELETE FROM kit_meta` if you want them gone). Risk: first prod boot creates tables in accounts.db (additive).

**Step 2. Matcher swap with a parity gate (pure function, no data).** Replace `buildSlurMatcher` internals with `@chatwarden/matcher.buildMatcher`, keep `mod_terms` storage, `LiveSlurMatcher` and `nameCheck` as they are; require Moxgate's whole `slurMatcher.test.ts`, `termsStore.test.ts`, `nameCheck.test.ts` and the POSITIVE/NEGATIVE/KNOWN_LOSSES corpora to pass unchanged. Optional shadow: count (class only, no text) lines where old and new matchers disagree for a few days. Rollback: revert the file. Visible change: none if parity holds.

**Step 3. Term store ownership (data move for terms only).** Migrate `mod_terms`/`mod_term_exceptions`/`mod_audit` into `kit_terms`/`kit_term_exceptions`/`kit_audit` (3.2), `markSeeded`, switch `LiveSlurMatcher` to `LiveTerms` and the term routes of the admin adapter to `termRoutes` (or call `LiveTerms` directly). Keep `strikes.term_id` working (ids preserved). Dry run + count check first. Rollback: flag back to the `mod_*` path; edits made after the switch are only in `kit_terms`, so run the reverse copy (a few lines of SQL) before rollback or accept re-entering them. Keep the flag off by default for a soak.

**Step 4. Profanity decision (optional, separate release).** Either keep obscenity in Moxgate (set kit `profanity.mode: 'allow'` and star in glue) or adopt `@chatwarden/profanity` with `style:'grawlix'` and accept the glyph change. Test the filter against Moxgate's chat tests. Rollback: revert.

**Step 5. Core cutover: identity, chat, doors, mutes, strikes, sanctions, reports on the kit (the big one; atomic as a set because all are keyed by subject).** Contents: async boot; a `Platform` adapter; `rooms.seat/unseat/close` hooks; `chat.accept` replaces `chatMod.process` + restriction + strike + buffer + mute filter (team audience, typing, frames, the gate stay glue); `doors.check` replaces `enforcement.ts`; `mutes.set/mutedSeats` replace `mutes.ts`; `reports.submit` replaces `handleReport`; one-shot data migration (subjects, sanctions, strikes, mutes, reports, threads) with dry run + counts + doors-equivalence check; the legacy path stays compiled behind `MOD_ENGINE=legacy` so a rollback needs only an env change + restart (`docker compose up -d --no-deps relay`). Keep `CHAT_MODERATION=off` working (do not build the kit). Set `limits.reporterFeedback:false`; no notices/warnings yet. Pre-flight: take a manual `VACUUM INTO` snapshot besides the hourly `accounts-backup.sh`; staging soak per the kit design doc. Rollback: `MOD_ENGINE=legacy` restores old behaviour using the untouched `mod_*` tables; sanctions/mutes/reports created after cutover exist only in kit tables, so ship a reverse-sync script (kit -> `mod_sanctions`/`chat_mutes`/`mod_reports`, inverting the mapping: subject -> its account/key ids) and run it before flipping back, or dual-write sanctions (kit + legacy) for the first week. This is the main risk.

**Step 6. Admin adapter on the kit.** Keep `/api/admin/mod/*` and moxops unchanged; implement the same routes on top of `cw.decide/history/sanctions/reports` and `LiveTerms`, translating `a:`/`k:` refs and keeping blocked/recent/test/notes on legacy or kit reads. Introduce roles (moxops passes a role header; the relay maps it to kit roles). Rollback: route flag back to the legacy handlers (they still work as long as `mod_*` is in sync, see Step 5 reverse sync).

**Step 7. Discord feed swap.** Replace `ModerationFeed`/`forumClient` with `@chatwarden/discord.discordFeed(cw, {webhookUrl: DISCORD_REPORTS_WEBHOOK, hubLink})` where `hubLink` maps to `https://ops.moxgate.com/#moderation/...`. Tell mods about the new thread naming; leave the term-change thread to a small Moxgate listener (the kit has none) or drop it. Rollback: re-enable the old feed (keep `mod_threads` untouched).

**Step 8. Player-facing notices, warnings, Community Rules, ref codes.** Build or adopt the UI (K4 player-react / K4c chat-react, or a small Moxgate NoticeDialog + `/rules` page), wire `platform.notify` -> a new WS `mod_notice_pending`, HTTP `playerRoutes`, door refusal screens ("See why"), warning-ack gate before the next game, then enable Warning/Note in the admin adapter and `limits.reporterFeedback`. This is the 11-09 spec Moxgate never implemented. Needs 6-locale copy. Rollback: feature flag hides the dialog; notices are additive.

**Step 9. Chat UI and translation (K4c).** Swap ChatPanel/ReportDialog/translation for `@chatwarden/client` + `chat-react` + `translate` when they exist, keeping Moxgate styling via theme variables. Until then these stay as they are (they talk to the relay's frames, which Steps 5-8 keep stable). Rollback: revert the component swap.

**Step 10. Hub UI (K4) and AI read (K3c).** Replace the moxops Moderator hub with `hub-react` and add the AI read (opt-in, level 2) later; kit phases K3c/K4. Retire the Step 6 adapter afterwards.

**Step 11. Cleanup** (>= 90 days after Step 5): drop legacy `mod_*`, `chat_*` tables and the legacy code path in a final migration (Moxgate migration v34+).

### Open questions for the owner / decisions the plan needs
1. `mod_notes`: freeze in Moxgate, migrate as `note` sanctions (counts toward `repeat`), or drop?
2. Profanity glyph change acceptable, or keep obscenity grawlix in glue?
3. Over-merging subjects: accept the kit's permanent transitive merge, or constrain the migration graph to reports/strikes/sanction groups only (recommended) and review the dry run?
4. Dual-write sanctions for a week after Step 5, or the reverse-sync script only?
5. Discord: accept `Case XXXXX` titles with no handle? (kit privacy default; Moxgate mods currently see masked handles.)
6. Who maps moxops roles to kit roles (a moxops change outside the relay)?

### Things I did not find / could not verify (explicit)
- A kit method to ask "is seat X currently chat-restricted?" for typing suppression: not found.
- A kit term-change Discord thread: not found.
- Moxgate Durable Objects / Postgres / D1 for moderation state: not found (none).
- Whether `npm install` with vendored `file:` tarballs and the `0.0.0` inter-deps resolves cleanly: not tested (no installs were run).
- Whether the kit's profanity word list matches obscenity's `englishDataset` + `englishRecommendedTransformers` as used by Moxgate: not verified.
- Which test runner (vitest vs jest) executes `server/index.test.ts` today: docs conflict (`vite.config.ts:250-256` include vs `server/jest.config.ts`).

---

## 7. Decisions (2026-11-09, made by the kit maintainers on the owner's "follow your recommendation" standing directive)

1. **`mod_notes`:** frozen. Moxgate keeps the table, and the admin adapter shows it read-only. Notes are not migrated as kit `note` sanctions, because that would change ladder `repeat` outcomes for existing players.
2. **Profanity:** no player-visible change. Moxgate keeps its obscenity grawlix censor in glue, and the kit runs with `profanity.mode: 'allow'`. Adopting `@chatwarden/profanity` is a later, separate decision.
3. **Subject merging:** the migration graph is constrained to the links that reports, strikes and sanction groups actually carry. Raw key↔account pairs only count when seen together on one of those rows. The dry run prints merge counts for review before the real run.
4. **Rollback for the core cutover:** a tested reverse-sync script (kit → `mod_sanctions` / `chat_mutes` / `mod_reports`) plus `MOD_ENGINE=legacy`. There is no dual write.
5. **Discord:** accept `Case XXXXX` titles with no handle (the kit's privacy default). Existing threads keep their names.
6. **Roles:** the relay maps moxops's two roles to kit `moderator` and `owner`. `senior` is granted per moderator in the relay config. moxops itself is unchanged.
7. **Kit gaps to close before the cutover:**
   - `cw.chat.restricted(who)` for typing suppression (new, small).
   - A term-change Discord notice. It stays a small Moxgate listener on `LiveTerms` changes; the kit gains nothing for it.

## 8. Phasing

| Phase | Inventory steps | Lands | Depends on |
|---|---|---|---|
| K6a | 0 spike, 1 deps + hasher parity + inert kit store, 2 matcher parity, 3 term store move | Moxgate local main, flags default off | KR tarballs |
| K6b | 5 core cutover + migration + reverse-sync | Moxgate local main behind `MOD_ENGINE` (default legacy until the owner soaks) | K6a, kit `chat.restricted` |
| K6c | 6 admin adapter (roles), 7 Discord feed swap | Moxgate local main | K6b |
| K6d | 8 player notices, warnings, Community Rules, ref codes UI (6 locales) | Moxgate local main | K6c |
| later | 9 chat UI and translation (K4c), 10 hub and AI (K4/K3c), 11 cleanup | — | kit K3c/K4/K4c |

Every Moxgate change lands on LOCAL main only. The owner pushes, because a push is the production deploy.
