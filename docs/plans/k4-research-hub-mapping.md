# K4 research: Moxgate moderator hub -> @chatwarden/hub-react (read-only findings, 2026-11-10)

Paths: MOX = C:\dev\moxgate\deploy\ovh\ops\ui\src (moderation/ = MOX\moderation). KIT = C:\dev\chatwarden\packages.
Moxgate server side: C:\dev\moxgate\server\moderation\modAdminRoutes.ts (PREFIX `/api/admin/mod`; ops proxies it as `/api/mod/*`).
Kit routes have NO prefix; the adopter chooses the mount point.

## 0. Headline findings

1. The kit staff API is a different, atomic, rule-citing, role-gated API, not a rename of Moxgate's. No straight port: the data
   layer (modApi.ts, modTypes.ts, parts of modView.ts) is rewritten and DecisionPanel changes shape.
2. Moxgate features with NO kit route: `/config`, `/recent` (Recent actions + "decisions 7 days"), `/blocked` (Blocked screen +
   Overview panel), `/test` (message tester), `/notes` as a route (kit: a `note`-kind sanction), reporter track record
   (`reporterRecord`, `asReporter`, `reportingSuspendedUntil`), linked accounts/browsers/`ipSeenWith`, `threadUrl`, `enforced`,
   term metadata (`note`, `addedBy`, `updatedBy`, `blocks30d`, `usingSeed`), sanction rows on history (groupId, reason, moderator,
   revoked*, targets counts) so Revoke has no groupId source, and `/api/me` role (adopter-owned; no kit whoami).
3. Kit routes with NO Moxgate UI: `GET/POST /gaps` (Rule gaps), `GET /policy` (profile, rules, summary, generated documents),
   `POST /reports/:id/suggest`, `suggest`/`rule`/`history` inside `GET /reports/:id` (ladder suggestion), `POST /terms/check`,
   cursor paging on `GET /reports` and `GET /audit`, audit filters (actor/action), the role/permission model.
4. @chatwarden/http `adminRoutes` + `createRouter` is bundleable for a browser in practice but NOT by design or test: one static
   `node:crypto` import on the admin path (admin/apply.ts:1) and a `Buffer` reference in body.ts:39. See section 4.
5. Moxgate has NO notices toast/modal, "My record" or rules page yet (unshipped 11-09 spec; K6). Only `ReportDialog.tsx` and an
   inline chat-restriction line exist. See section 5.

## 1. Per-screen mapping

Line counts (wc -l): ModeratorHub.tsx 107, Overview 123, ReportQueue 77, ReportView 139, DecisionPanel 275, SanctionForm 137,
PlayerHistory 239, TermsPanel 138, TermForm 121, BlockedAttempts 71, AuditLog 45, ModGuide 239, modApi.ts 90, modTypes.ts 163,
modView.ts 529, modShared.tsx 208, mod.css 169, modTestKit.ts 78. Tests: ModeratorHub.test.tsx 1018, ModWork.test.tsx 944,
modView.test.ts 713, ModGuide.test.tsx 230. Whole dir 5853 lines incl. tests. Helpers imported from OUTSIDE moderation/:
`../format.js` relativeTime (88-line file), `../listCap.js` capList (22), `../responsive.js` useIsNarrow (156), `../TableScroll.js` (39),
`../MoreToggle.js` (30), `../ccTheme.js` (28). hub-react must carry its own copies.

Kit error body: `{ error: <code>, message }` (http/src/errors.ts TABLE 19-37). Moxgate: `{ error, detail?, hits? }`.
Kit codes: invalid_request, invalid_json, forbidden_key, invalid_query, invalid_value, invalid_profile, invalid_sanction,
invalid_rules, invalid_excerpt, invalid_term, invalid_gap_ref, invalid_idempotency_key, unauthorized 401, forbidden 403,
not_found 404, method_not_allowed 405, already_decided 409, in_progress 409, idempotency_mismatch 409, payload_too_large 413,
rate_limited 429 (+retry-after), internal 500. Moxgate codes the UI special-cases with no kit equivalent: MOD_OFF (hub-wide notice),
RELAY_UNAVAILABLE, BAD_ID, UNKNOWN_SUBJECT (force), ALREADY_REVOKED (kit: 404 not_found), HITS (+hits[], confirm), DUPLICATE,
INVALID (+detail). Kit collapses every term refusal to 400 invalid_term with no detail.

### 1.1 ModeratorHub.tsx (107) - shell, router, tabs, MOD_OFF notice, guide hint
- Shows header + sub-tabs (Overview, Reports, Slur list, Blocked, Audit, Guide), first-visit guide hint (localStorage), one hub-wide
  "Moderation isn't switched on" notice, hash routing via parseModHash (modView.ts ~215-260).
- Endpoints: none directly (ModContext.markOff is fed by panes).
- Kit: nothing equivalent. Gaps: no whoami/role route; MOD_OFF analog is adopter-side.
- Port: hash router becomes a `router` adapter prop (hash default so the demo can embed); add Gaps (and Policy/Guide) tabs; hide Audit
  unless role >= senior (permissions.ts PERMISSIONS 'audit.read': 'senior').

### 1.2 Overview.tsx (123) - stats strip, Needs review, Recent actions, Recently blocked
- Calls: GET /api/mod/queue?status=open; GET /api/mod/recent?limit=100; GET /api/mod/blocked?days=7.
- Kit: queue -> `GET /reports?status=open`. `/recent` and `/blocked`: NONE.
- "Waiting N players / M reports" and "Longest wait" are computable by grouping items on `targetPerson` client-side. "Decisions, 7 days"
  could be approximated from `GET /reports?status=actioned|dismissed` (`actionedAt`) but sanctions, revokes and auto-timeouts are
  listed nowhere (only in-process events 'sanction.applied' etc. in core/chatwarden.ts, or the senior-only id-only audit trail). Blocked
  panel has no source: core stores StrikeRow {id,at,subject,roomId,termId,rawLine} (core/types.ts ~213-229, purged 30 d) but no facade
  method and no route.
- Needs new kit surface for parity: `GET /recent`, `GET /blocked`; or v1 drops those panels.
- Should gain (not in Moxgate UI): Rule gaps list (feature-contract ~255), AI provenance label/filter (design ~347, K3 unbuilt).

### 1.3 ReportQueue.tsx (77) - queue grouped by reported player, status segmented control, "Earlier reports"
- Calls: GET /api/mod/queue?status=open|actioned|dismissed|all -> `{ groups: QueueGroup[] }`.
- QueueGroup: `{ subject:{account?,key}, ref ("a:<id>"|"k:<key>"), handles[], categories[], reports, tables, reporters, latestAt, reportIds[] }`.
- Kit: `GET /reports?status&cursor&limit` -> `{ items: ReportSummary[], next: string|null }` (admin/reports.ts ~25-37, 66-79).
  ReportSummary = `{ id, createdAt, roomId, tags: Record<string,string>, category, status, badFaith, targetPerson, reporterPerson, actionedAt, actionedBy }`.
  `limit` 1..200 default 50 (must match /^\d{1,9}$/ else 400 invalid_query); `status` open|actioned|dismissed, omit = all.
- Differences: kit is flat and paged, Moxgate pre-grouped and unpaged. Grouping becomes a pure hub function (by `targetPerson`;
  tables = distinct `roomId`; reporters = distinct `reporterPerson`; categories = distinct `category`; latestAt = max createdAt).
  No handle in the summary (deliberate: "no chat text, handle, seat"), so a row cannot show a name without N extra
  `GET /reports/:id` calls (each is an audited `report.view`, and a REQUIRED audit write that 500s if it fails). Decision for plan:
  show a short person ref, or add `targetHandle` to ReportSummary. Ref is an opaque canonical SubjectId, not `a:`/`k:`.
  Hub must follow `next`. Severity/AI sort chip (feature-contract ~42, 156-163) not in kit.

### 1.4 ReportView.tsx (139) - the case page
- Calls: GET /api/mod/reports/:id -> ReportDetail; GET /api/mod/history?subject=<ref> (record line + reach).
- Kit: `GET /reports/:id?level=banter|rude|hostile|severe` -> `{ report: StaffReport, history: Record<person, ActionRecord[]>, suggest: Suggestion, rule: RuleRef }`
  (admin/reports.ts ~92-101). `history` is keyed by every person on the report (peopleOf), so ONE call replaces Moxgate's two.
- Field mapping Moxgate ReportDetail -> kit StaffReport (core/staffReports.ts, core/types.ts ~277-320):
  - same names: id, createdAt, category, note, lineId, status, modNote, actionedBy, actionedAt, badFaith.
  - roomCode -> `roomId` (string, may be ''); gameId/format -> absent, adopter data rides in `tags`.
  - ref -> `targetPerson` (canonical; `targetSubject` = id at filing time).
  - reporter {seat,handle,key,account} -> flat `reporterSeat`, `reporterHandle`, `reporterPerson`/`reporterSubject` (no key/account by design).
  - reported {...} -> `targetSeat`, `targetHandle`, `targetPerson`/`targetSubject`. reporterRef -> `reporterPerson`.
  - people[] {seat,handle,ref,role} -> `people: SubjectId[]` canonical, first-seen excerpt writers, `excerpt[].p` indexes it. No
    handle/role/seat per person: derive handle from excerpt lines, role by equality with targetPerson/reporterPerson. Moxgate relied on
    server order "reported first, reporter second": NOT true in the kit.
  - excerpt[] `{lineId,ts,seat,handle,raw,delivered,audience:string,blocked}` -> `{lineId,ts,seatId,handle,raw,delivered|null,blocked,audience:string[]|null,p:number|null}`.
    seat -> seatId (opaque, not 'p1'..'p6'); audience = seat ids who could see it, null = whole room. Moxgate `team:<name>` + teamLabel() do not apply.
  - NEW in kit, no UI yet: `ownLineIds: Record<person,string[]>` (notice-excerpt picker, max 5), `badFaithEvidence`, `tags`, `suggest {outcome,label,why}`, `rule`.
  - MISSING in kit (UI shows them): `reporterRecord {reports,open,actioned,dismissed,badFaith}`, `reportingSuspendedUntil`. Core has the suspension logic
    (core/reports.ts SUSPEND_AFTER) but no read API or route.
  - recordLine() ("First report about this player. No strikes, no sanctions.") needs strikes, sanctions and report counts. Kit `history` is
    `ActionRecord[]` `{kind,durationMs,startsAt,revoked,automated,roomId}` (core/ladder.ts:19, 90-day window): no strikes, no report count.
  - Needs a conduct-level picker (`?level=`) to recompute the suggestion.
- Excerpt UI (reported-line mark, blocked strike-through, "Only <name>" filter, "<name> sent no messages" warning) ports after person re-derivation.
  Coverage text "last 15 minutes or 100 lines" is hardcoded Moxgate relay config (modView.ts coverageLine ~485); drop or make a prop.

### 1.5 DecisionPanel.tsx (275) - the biggest rewrite
- Moxgate flow: verdict radios (fair | unfair | badfaith) -> per-person action select (5 presets or "Something else" kind chat/open_table/ban x
  1h/24h/7d/30d/permanent) + "also their network" -> optionally extra people at the table -> one reason (<=500) -> submit does N x
  `POST /api/mod/sanctions` then `POST /api/mod/reports/:id/status {status:'actioned'|'dismissed', note, badFaith?}`, with partial-failure
  "Finish" retry state (landedRef, DecisionPanel ~118-175, 225-230).
- Kit: ONE call `POST /reports/:id/decide { verdict, actions, reason, evidence? }` -> `{ ok:true, replay:boolean, groups:[{refCode,kind}] }`
  (admin/reports.ts ~101-112; parseDecision admin/apply.ts ~29-43). Atomic and idempotent, so the landedRef/"Finish" machinery goes away;
  repeat = `replay:true`; second different decision = 409 already_decided.
- Verdict map: fair -> `upheld` (or `noted` if every action is kind `note`; noted needs >=1 action); unfair -> `no_action`; badfaith -> `bad_faith`.
  `bad_faith` REQUIRES `evidence` (1..500 chars) and evidence is forbidden for the other verdicts: a new required field. `no_action`/`bad_faith`
  may act on reporter/others, never on the target (core/decide.ts ~44-51).
- DecisionAction (core/decide.ts:23): `{ subject, kind:'chat'|'area'|'ban'|'warning'|'note', durationMs:number|null (REQUIRED; null=permanent; <=365 d; must be null for warning/note), rule:number|'uncovered' (REQUIRED), gapNote? (required with 'uncovered', <=500), includeIp?, lineIds? (<=5, subject's own lines) }`. Max 20 actions (apply.ts MAX_ACTIONS). Body cap 64 KiB. reason <=2000 at http layer, <=500 after trim at the facade.
- Differences from Moxgate: `open_table` -> `area`; new kinds `warning` (player must ack, no duration) and `note`; `duration` enum -> `durationMs`;
  NEW required Community Rule picker (rules from `GET /policy`, "No rule covers this" + gapNote); NEW own-lines excerpt picker; NEW ladder suggestion banner;
  Moxgate's `force`/UNKNOWN_SUBJECT "sanction anyway?" gone. Permanent ban (`kind:'ban', durationMs:null`) needs `sanctions.apply.ban_permanent` (senior):
  gate the "Permanent" option by role. Any action needs `sanctions.apply`; deciding with no actions needs only `reports.decide` (moderator).
- Presets: generate from core `LADDER_TABLE` (ladder.ts, 6 steps x lowMedium/high cells: Warning, Restrict chat 24 hours/7 days, Full ban 7/30 days/permanent) instead of Moxgate ACTION_PRESETS (modView.ts ~118-124).
- Response has `refCode` but NOT target counts or `enforced`, so the "applied to N accounts, M browsers, K networks" message and SANCTIONS_OFF_TEXT lose their source.
  Reach text ("Reaches N accounts and M browsers linked to X", `reach()` DecisionPanel 14-20) needs `history.linked`, absent in kit.
  "The outcome posts to the Discord thread" (line 270) is discord-package specific: prop or drop.
- AI (design ~335-360, K3 unbuilt): L2 "decision panel opens pre-filled, marked AI suggestion", L3 one-click reversal, provenance label (`source:'ai'`): no kit routes yet; leave slots.

### 1.6 SanctionForm.tsx (137) - direct sanction on a player page
- Calls: POST /api/mod/sanctions `{ subject, kind, duration, includeIp, reason, force? }` -> `{ groupId, targets:{accounts,keys,ips}, duration, enforced? }`.
- Kit: `POST /sanctions { subject, kind, durationMs, rule, gapNote?, includeIp?, reason? }` -> `{ groupId, refCode }` (admin/sanctions.ts). `lineIds` refused here.
  Perm `sanctions.apply` (+ `sanctions.apply.ban_permanent` for durationMs null).
- Gaps: no `targets` counts / linked list / `ipSeenWith` / `enforced`; no `force`; needs rule picker; `reason` optional in kit (keep required in UI, <=500).
  Moxgate hash "act" links (`#moderation/player/<ref>/act/<kind>/<duration>`, from Discord) have no kit counterpart (the discord package builds its own links).

### 1.7 PlayerHistory.tsx (239) - timeline (reports, strikes, sanctions, notes), active sanctions + Revoke, Add note, linked, Sanction form
- Calls: GET /api/mod/history?subject=; POST /api/mod/sanctions/:groupId/revoke `{reason}`; POST /api/mod/notes `{subject, body}` -> `{id}`.
- Moxgate PlayerHistoryData: `{ ref, reports[{id,createdAt,category,status,handle,roomCode}], strikes[{id,at,roomCode,termId}],
  sanctions[{groupId,kind,startsAt,endsAt,reason,moderator,auto,revokedBy,revokedAt,revokeReason,active,targets}], notes[{id,body,moderator,createdAt}],
  linked{accounts[],keys[],ipSeenWith}, threadUrl, enforced?, asReporter?, reportingSuspendedUntil? }`.
- Kit: `GET /people/:ref/history?limit` -> `{ history: ActionRecord[], reports: [{id, createdAt, category}] }` (admin/reports.ts ~117-131; default 20 reports; perm
  `history.read`; audited `history.view`). ActionRecord = `{ kind, durationMs, startsAt, revoked, automated, roomId }` (core/ladder.ts:19), 90-day lookback only.
  NB the path param is plain `:ref` (charset `A-Za-z0-9_-`, 1..64), not `:ref~ref`.
- MISSING for parity: groupId (cannot call revoke from this data), reason, moderator/actor, endsAt (derive startsAt+durationMs), refCode, rule, source, note text,
  strikes, linked accounts/browsers/ipSeenWith, report status/handle/roomCode, asReporter, reportingSuspendedUntil, threadUrl, enforced.
  Key gap: the kit needs a read route returning sanction groups (groupId, refCode, kind, rule, startsAt, endsAt, reason, actor, source, automated, revoked*) or the
  history tab and Revoke cannot be built.
- Revoke: `POST /sanctions/:groupId/revoke { reason }` -> `{ ok:true }`; 404 not_found for unknown OR already revoked (map 404 to Moxgate's ALREADY_REVOKED-as-success).
  Perm `sanctions.revoke`. Kit revoke also withdraws the player's notice.
- Notes: kit has no notes table or route; a note is a sanction with `kind:'note'`, `durationMs:null`, `rule` required, `reason` = text (<=2000) via POST /sanctions.
  History returns it as an ActionRecord with no text.
- "Active" must be recomputed (kit ladder counts 90 days; warnings expire at 90 d).

### 1.8 TermsPanel.tsx (138) + TermForm.tsx (121) - slur list: tester, terms by language, exceptions, add/edit/disable
- Calls: GET /api/mod/terms -> `{usingSeed, terms[], exceptions[]}`; POST /api/mod/terms | /exceptions (`{term|phrase, language, note, confirm?}`);
  PATCH /api/mod/:family/:id; POST /api/mod/:family/:id/active `{active}` -> `{ok, changed}`; POST /api/mod/test `{text}` -> `{verdict: blocked|starred|clean|too_long, termId?}`.
- Kit (admin/terms.ts; only mounted when `AdminRoutesOptions.terms` is passed): `GET /terms` -> `{ terms:[{id,term,language,active}], exceptions:[{id,phrase,language,active}] }`;
  `POST /terms/check {term, language}` -> `{hits:string[]}` (dry run vs pack corpus + `recentLines()`); `POST /terms {term, language, note?}` -> `{id}`;
  `PATCH /terms/:id~ref {term?,language?,note?}` -> `{ok:true}`; `POST /terms/:id~ref/active {active:boolean}` -> `{ok:true}`; same trio under `/exceptions` with `phrase`.
  Perms `terms.read` / `terms.write` (both moderator).
- Differences:
  - Row fields MISSING from GET /terms: `note`, `addedBy`, `addedAt`, `updatedBy`, `updatedAt`, `blocks30d`, and `usingSeed`. Columns "Last changed by", "Note", "Blocks, 30 days" and the
    seed-list warning have no data. The note can be written (POST accepts it) but never read back, so the edit form cannot prefill it.
  - Add flow: Moxgate = POST then relay answers 400 HITS with `hits[]`; UI resends with `confirm:true` ("Save anyway", audited). Kit = explicit `POST /terms/check` first; POST has NO `confirm`;
    any matcher refusal (duplicate, malformed, last active term, negative-corpus violation) is a flat 400 `invalid_term` without detail. TermForm's DUPLICATE/INVALID/HITS branches collapse.
  - Limits: kit word <=200 (Moxgate WORD_MAX 100), note <=500 (same), language regex `^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$` (Moxgate LANGUAGE_RE `^[a-z]{2,3}(-...)?$`); toggle has no `changed`.
  - "Test a message" (`/test`): NO kit route. Gap (add e.g. `POST /terms/test` or drop the box). CHAT_MAX_LEN=200 in modView.ts is Moxgate's chat limit.
  - Never-delete semantics match (kit has no delete route). A write leaves TWO audit rows (editor + route).
  - Language labels {en,es,pt} / LANGUAGE_ORDER (modView.ts ~340) are Moxgate-specific: use Intl.DisplayNames.

### 1.9 BlockedAttempts.tsx (71) - blocked chat messages, 1/7/30 days, "Add exception" (TermForm family=exceptions prefilled), "View term"
- Calls: GET /api/mod/blocked?days= -> `{ blocked:[{id,at,roomCode,termId,term,language,ref,text}] }`.
- Kit: NONE. Source data exists (StrikeRow: rawLine, termId, subject, roomId; purged after 30 d) but no facade method or route. Showing `rawLine` to staff is a privacy call the kit has not made.

### 1.10 AuditLog.tsx (45) - last 100/250/500 entries with "what changed"
- Calls: GET /api/mod/audit?limit= -> `{ entries:[{id,at,actor,action,subject,before,after}] }`.
- Kit: `GET /audit?cursor&limit&actor&action` -> `{ items:[{id,at,actor,role|null,action,target?:{type,ref}}], next }` (admin/audit.ts; default 50, max 200; perm `audit.read` = SENIOR).
  Actions (core/audit.ts:14): report.view, report.decide, sanction.apply, sanction.revoke, gap.close, term.add/update/toggle, exception.add/update/toggle, history.view, suggest, policy.view.
  Target types: report|sanction|person|term|exception.
- Differences: `subject` -> `target {type, ref}`; NO `before`/`after` (ids only by design) so summarizeChange() and the "What changed" column go; NEW `role` column, cursor "Load more",
  actor/action filters. 100/250/500 -> pages of <=200. Reading the audit writes no row; viewing a report or history DOES (and 500s if the write fails).

### 1.11 ModGuide.tsx (239) - nine static sections; tables rendered from the same constants as the form
- Calls: GET /api/mod/config -> `{forumUrl}` (only for the Discord forum link; ops answers it even with the relay down).
- Kit: `GET /policy?format=markdown|html|text` -> `{ profile, rules, summary, documents:{codeOfConduct, moderatorGuide, agentBrief} }` (admin/policy.ts; perm `policy.read`; audited `policy.view`).
  `documents.moderatorGuide` is generated by core from the profile and rules in force. Hub Guide should render it (needs a safe markdown renderer, or sanitised html) plus
  static sections; keep the "render tables from constants" principle using LADDER_TABLE. `rules` (incl. retired) also feeds the Rules view and the rule picker.

### 1.12 Kit routes with no Moxgate UI (new screens)
- Rule gaps: `GET /gaps` -> `{ items: GapRow[] }`, GapRow = `{ groupId, refCode, at, actor, note, rule:'uncovered', status:'open'|'ruled'|'not_a_rule' }` (core/chatwarden.ts:66; perm gaps.read = moderator).
  `POST /gaps/:groupId/close { status:'ruled'|'not_a_rule', ref? }` (`ref` = number of an active rule, required for `ruled`; null/absent for `not_a_rule`) -> `{ok:true}`; perm `gaps.close` = OWNER;
  400 invalid_gap_ref; 404 unknown/closed. The route writes no audit row (core writes `gap.close`).
- Suggestion: `POST /reports/:id/suggest { level?, rule?, person? }` -> `Suggestion { outcome:'none'|'note'|'warning'|{kind,durationMs}, label, why }`; `person` must be named on the report; audited `suggest`.
  Use for "what if rule 3 / hostile?" re-suggest.

## 2. Moxgate-specific things to drop or generalize
- Rooms/seats/protocol: `SeatId = 'p1'..'p6'` + `seatLabel()` "Seat 3" (modTypes.ts ~21, modView.ts ~476); `roomCode` as "Table XYZ" and `format` (commander) in ReportView meta; "tables" count
  in QueueGroup/GroupRow; `gameId`; team chat `audience: 'team:<name>'` + `teamLabel()`; "Chat at the table" heading; "open tables / Quick play / Ranked / Games with friends" and "banned from Moxgate"
  inside SANCTION_KINDS (modView.ts 28-45) and Guide. -> kit `roomId`, `tags`, opaque `seatId`, kind `area`, caller-supplied labels.
- Refs: the `a:<accountId>` / `k:<playerKey>` scheme, `shortRef`/`shortSubject`/`SubjectTag`, `isSubject()`, `SUBJECT_MAX`, ID_RE, `linked.accounts/keys`, "browser/account/network" nouns, `reach()`.
  Kit refs are opaque canonical SubjectIds; the kit never reveals accounts, keys or IPs to staff. Generalize to a `PersonTag` (first 8 chars); drop reach text unless the kit adds counts.
- Sanction vocabulary: ModKind chat|open_table|ban, ModDuration enum, ACTION_PRESETS, OTHER_ACTIONS, verdict names (fair/unfair/badfaith), IP_NOTE (keep idea, tie to the kit's 24 h IP cap).
- Moxgate switches/ops: MOD_OFF (`MOD_OFF_TEXT`), MOD_SANCTIONS / `enforced` (`SANCTIONS_OFF_TEXT`), `/api/mod/config` + `forumUrl`, "Discord moderation forum", Discord action-link routes
  (`#moderation/report/:id/act/dismiss`, `/player/:ref/act/:kind/:duration`, legacy `queue`), `threadUrl` + `safeExternalUrl('thread')`, "The outcome posts to the Discord thread",
  localStorage `mox_ops_mod_guide_seen`, hash prefix `#moderation`.
- Ops-shell coupling: hub is a tab (App.tsx:20,91), role from `/api/me` (navView.ts OpsRole 'owner'|'moderator'), imports ../format ../listCap ../responsive ../TableScroll ../MoreToggle ../ccTheme.
- Copy: ModGuide prose is Moxgate-specific throughout (one literal "Moxgate" at line 174, plus forum/Discord/"slur list" wording); "slur list" (tab label, TermsPanel headings) -> "Blocked terms".
  categoryLabel (harassment, hate, cheating, spam, disruption, other) matches kit ReportCategory 1:1: keep.
- Moxgate locales: the HUB has none (section 3: all literals are English). The 6 locales are the game CLIENT's `t()` (src/i18n/catalog, keys `moxgate.chatModeration.*`). Design K4: "en strings plus an
  i18n hook (adopter passes `t`); Moxgate passes its 6 locales" => hub-react must extract every literal in the ~12 files into a keyed catalog with params/plurals (replace `plural()` modView.ts ~367).
  Several hundred strings incl. the Guide.
- Styling tokens: theme.css vars `--bg --surface --raised --border --border2 --fg --muted --faint --data --data-soft --compare --brand --brand-ink --ok --warn --bad --ok-bg --warn-bg --bad-bg --idle-bg --sans --mono`
  (light, dark via prefers-color-scheme, `[data-theme]` override), ccTheme.ts constants (MUTED LINE GOLD RED GREEN PANEL INK VIOLET), Geist fonts, the `.mh` scope in mod.css. Plan: same variable contract
  renamed `--cw-*` with these defaults, class scope `.cw-hub`, and move the inline CSSProperties (modShared `th/td/panel/note/input/btn`, `Notice`) into CSS (CSP, dark mode, theming).

## 3. Moxgate ops UI stack
- Package MOX\..\package.json (`moxops-ui`, private, type module). deps: react ^19.0.0, react-dom ^19.0.0, mana-font, uplot. devDeps: @types/react(-dom) ^19, @vitejs/plugin-react ^4.3,
  typescript ~5.7, vite ^7.3.7. NO router, NO data library, NO CSS framework, NO test libs of its own, NO i18n lib.
  Root C:\dev\moxgate\package.json supplies: react ^19.2, react-router-dom ^7.18.2, @testing-library/react ^16.3.2, @testing-library/dom ^10.4.1, happy-dom ^20.8.9, vitest ^4.1.0.
- Build: MOX\..\vite.config.ts = @vitejs/plugin-react + a `mana-font-modern-only` plugin (irrelevant); outDir `../dist-ui`; dev proxy `/api` -> 127.0.0.1:9099; `fs.allow` repo root.
  tsconfig: strict, jsx react-jsx, ES2022, noEmit, moduleResolution bundler, `.js` specifiers on relative imports, noUncheckedIndexedAccess OFF.
- Routing: hand-rolled hash router. App.tsx 26-71 tracks `window.location.hash` with a `hashchange` listener; navView.ts maps `#moderation[/...]` to the tab; ModeratorHub.tsx 38-52 re-listens;
  parseModHash/modHash (modView.ts ~215-290) parse/build routes. Nav items are plain `<a href>`. react-router is NOT used in the ops UI.
- Data fetching: plain `fetch` in `call()` (modApi.ts 27-47), absolute `/api/mod/...` paths (no base URL, no auth code; Cloudflare Access in front) + custom hooks
  `useModData(key, load)` (modShared.tsx ~33-60: key-scoped, stale-answer guard via a seq ref, no polling, keeps last good data on failed reload) and `useModAction(refetch?)` (~65-95: busy/error,
  `expect` codes returned untouched, refetch after an unconfirmed write: 502/0). `ModApiError {status, code, detail?, hits?}`.
- CSS: (a) `mod.css` (169 lines) scoped under `.mh`: 12-col grid, `.panel/.ph/.pb/.pfoot`, tags `.tag.ok/warn/bad/idle`, buttons `.btn(.primary/.danger/.ghost)`, rows `.qrow/.arow/.brow/.line`, `.seg`, `.crumbs`, `.hint`, `.guide`;
  (b) inline `CSSProperties` objects from modShared.tsx used by PlayerHistory, SanctionForm, TermsPanel, TermForm, BlockedAttempts, AuditLog, ModGuide; (c) theme.css tokens. JS media query `useIsNarrow` switches control padding.
- Tests: vitest from the ROOT; per-file docblock `// @vitest-environment happy-dom`; @testing-library/react (render, screen, fireEvent, waitFor, within, cleanup); `vi.stubGlobal('fetch', ...)` fake of /api/mod/*
  (`installApi` in ModeratorHub.test.tsx 9-25 and modTestKit.ts) recording calls; `window.location.hash = ...` navigation; pure logic in modView.test.ts (node env, 713 lines). Root vite.config.ts includes
  `deploy/ovh/**` tests and warns about a duplicate-React hazard (ops/ui node_modules vs root react): declare react/react-dom as peerDependencies in hub-react. No axe/a11y tests.
- i18n: none. Hard-coded English; times via `toLocaleString()`.
- Kit site stack for comparison (C:\dev\chatwarden\site\package.json): react ^19.3.1, vite ^8.3.7, @vitejs/plugin-react ^6.3.0, jsdom ^31, @testing-library/react ^16.3.3, user-event ^14.6.9,
  @axe-core/playwright ^4.14. hub-react tests should use jsdom + user-event (+ axe), not happy-dom.

## 4. Is @chatwarden/http adminRoutes/createRouter bundleable for a browser?

Verdict: YES in practice (a bundler that stubs/externalizes `node:crypto` plus tree-shaking), but NOT by design and NOT covered by any test. Two latent hazards and one enforcement gap.

Files and lines (KIT\http\src):
- `admin/apply.ts:1` `import { createHash } from 'node:crypto';` used ONLY at `admin/apply.ts:167` inside `sanctionFingerprint` (webhook idempotency fingerprint; consumer: `webhooks/in.ts`). `admin/reports.ts` and
  `admin/sanctions.ts` import apply.ts (parseDecision, applyDecision, parseSanction, needFor*), so this static `node:crypto` import is ON the admin path. Vite/Rolldown stubs it ("externalized for browser
  compatibility") and tree-shakes `sanctionFingerprint`; esbuild `platform:'browser'` with `external: []` FAILS to resolve it.
- `body.ts:39` `Buffer.byteLength(rawBody, 'utf8')` is on the admin path (`parseJson` via `admin/validate.ts` bodyObject). Guarded by `rawBody.length * 3 > max` (max 65536, so only bodies > 21845 UTF-16 units). In a browser without
  `Buffer` that throws ReferenceError -> `withErrors` -> 500 `internal`, and an oversize body no longer yields 413. Fix: `new TextEncoder().encode(raw).length`. Same pattern at `webhooks/in.ts:190`.
- The root barrel `index.ts:37` re-exports `./player.js` and `index.ts:38-59` re-exports `./webhooks/*`; those import Node: `player.ts:1` (`createHash, randomBytes`; **`randomBytes(32)` runs at player.ts:131 inside `playerRoutes()` at construction**, `createHash` at 141),
  `webhooks/sign.ts:1` (`createHmac, timingSafeEqual`; `Buffer.from` at 115-116), `webhooks/out.ts:1` (`randomUUID`, used at 322). So `playerRoutes()` CANNOT run in a browser as written; `adminRoutes()` can.
- `express.ts` (Buffer at 74-153) is a separate entry (`@chatwarden/http/express`, package.json exports) and is NOT in the root barrel. `sideEffects:false` is set (package.json ~47), so tree-shaking is permitted.
- Everything else on the staff path is Node-free: `router.ts` (createRouter, compileRoutes), `errors.ts`, `auth.ts`, `permissions.ts`, `types.ts`, `admin/{context,reports,sanctions,gaps,terms,policy,audit,validate}.ts`.
  `AdminRoutesOptions.terms` is a structural interface (no matcher import) so `LiveTerms` fits. `@chatwarden/core` is verified browser-safe (core/src/crypto.ts header: `process.getBuiltinModule` guarded lookup, pure-JS SHA-256/HMAC fallback).
- Enforcement gap: `scripts/browser-bundle.test.ts` + `scripts/browser-entry.ts` prove ONLY core, matcher (+fixtures) and store-memory (esbuild browser, `external: []`, no `node:` specifier, 120 KiB gzip budget, vm with no process/Buffer).
  `@chatwarden/http` is not in the entry. The site depends on core, matcher, store-memory only; `site/src/demo/kitEngine.ts` calls `cw.*` directly, and `site/src/demo/ModPane.tsx` (257 lines) is a hand-built mock mod pane
  that hub-react is meant to replace (plus `site/src/demo/ReportDialog.tsx` 155, `notice.ts` 152).
- Cheap fixes for the plan: (1) replace `Buffer.byteLength` in body.ts:39 and webhooks/in.ts:190 with a TextEncoder length; (2) move `sanctionFingerprint` and its `node:crypto` import out of admin/apply.ts into webhooks/
  (or use core's isomorphic hasher); (3) add a browser-safe subpath, e.g. `@chatwarden/http/admin` (router + errors + auth + permissions + admin only), mirroring `./express`, keeping player/webhooks off the browser path (or make
  player.ts use WebCrypto); (4) add that subpath to scripts/browser-entry.ts so the existing no-`node:` scan covers it and set a size budget.
- Demo wiring once fixed: `const handle = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }), terms: liveTerms }))`. hub-react's API client takes an injectable transport
  `(method, path, body?) => Promise<{ status, body }>`; the in-browser one builds `KitRequest { method, path, query, headers: {}, body: undefined, rawBody: JSON.stringify(body) }` and calls `handle(req)`. `rawBody` MUST be supplied
  (parseJson reads rawBody, never `body`). `KitResponse.body` is a JSON value except string bodies (documents) which are raw. The real app uses the same seam with `fetch` + base URL, so the hub cannot tell the difference.
- Without the fixes a Vite/Rolldown site build would very likely still succeed (stub, nothing calls createHash on the admin path), but the Buffer and `playerRoutes` hazards remain and esbuild consumers and tests fail.

## 5. Player-side components (Moxgate client = C:\dev\moxgate\src; relay = C:\dev\moxgate\server)
- Report dialog: EXISTS. src\components\ChatPanel\ReportDialog.tsx (169) + ReportDialog.module.css + ReportDialog.test.tsx. Opened from a chat line (passes `lineId`) or a seat. Uses the Moxgate store
  (`useGameStore.sendReport`, `lastReportAck`, `toggleChatMute`), `t('moxgate.chatModeration.*')` (6 locales), `ArtifactDialogFrame/InlineAlert/PgButton/PgInput` from ../ui, CSS modules.
  Transport is the game WebSocket (`report` / `report_ack`), not HTTP. Refusals map `ReportRefusal`: duplicate, rate, self, not_player, off, suspended (+ client-only `unsent` after a 10 s ANSWER_TIMEOUT), identical to kit
  `ReportRefusal` (core/reports.ts:44). "Also mute" is tied to the Moxgate chat slice. Eligibility: ChatPanel/reportEligibility.ts (`canReportSeat`).
  Kit match: NO HTTP report-intake route in packages/http (player.ts exposes only notices, record, rules, code-of-conduct, names/check). Intake is `cw.reports.submit(ReportInput)` ->
  `{ok:true, reportId, remaining} | {ok:false, refused, remaining?}`, called by the adopter's own transport. So player-react's ReportDialog is transport-agnostic (`onSubmit(input): Promise<ReportResult>`); nearest existing
  implementation: C:\dev\chatwarden\site\src\demo\ReportDialog.tsx. "Report budget made visible" (design addition 6) uses `remaining`.
- Restricted-chat line: EXISTS inline. ChatPanel.tsx ~282-390: `activeChatRestriction({chatRestriction})` renders `data-chat-restricted` composer notice with `restrictedForever` / `restrictedUntil` (`formatSanctionTime`,
  utils/sanctionTime) / `restrictedByMod`, driven by relay frames. Kit: no HTTP; data comes from the adopter's `cw.doors`/`chat.accept` refusals. player-react component is presentational (`until`, `byModerator`, optional `refCode`/notice link).
- Notices toast/modal: DOES NOT EXIST in Moxgate. No ModNotice/PlayerNotice/api/notices/mod_notice anywhere in src, server or shared. It is 11-09 spec part C (feature-contract ~301-375: `GET /api/notices`, `POST /api/notices/:id/ack`,
  WS `mod_notice_pending`, held until the game ends, warning must be acked before the next join, ban screen). Nearest reference: site\src\demo\notice.ts and GamePane.tsx.
  Kit: `GET /notices` -> `{ notices: PlayerNotice[] }`; `POST /notices/:id/ack` -> `{ ok:boolean }` (200 even if not theirs). PlayerNotice (core/notices.ts:30) = `{ id, kind:'warning'|'chat'|'area'|'ban'|'report_outcome',
  rule:RuleRef|null, ruleLabel:string|null, until:number|null, refCode:string|null, excerpt:[{text, day:'YYYY-MM-DD'}] (<=5), createdAt, mustAcknowledge:boolean }`. Responses carry `cache-control: no-store`.
  Identity comes from `PlayerOptions.identify(req)` (clientKey/accountId/ip) so the browser sends the adopter's own credential header. Component: NoticeDialog/Toast queue (oldest first, Acknowledge when `mustAcknowledge`,
  excerpt, `refCode` + "think this is a mistake?" link prop, `canShow` prop to hold during a game); the WS "pending" nudge stays adopter-side.
- My record: DOES NOT EXIST in Moxgate (design "Additions from the industry survey" #4, ~line 392). Kit: `GET /record` -> `{ record: PlayerNotice[] }` (sanction notices still applying: warnings 90 d, others while
  permanent/running/under 90 d; report outcomes never; revoked disappear). Component: list with kind, rule label, until, refCode.
- Rules page: DOES NOT EXIST in Moxgate (spec: `communityRules.ts` shared by relay/client/hub, static; feature-contract ~234-239). Kit: `GET /rules` -> `{ summary, rules:[{number,title,text}] }` (active only) and
  `GET /code-of-conduct?format=html|markdown|text` (string body; html is a full document with CSP `default-src 'none'; style-src 'unsafe-inline'`, so embed markdown/text or a sandboxed iframe, never innerHTML).
  `POST /names/check {name}` (rate-limited 20/min, 429 + retry-after) has no counterpart in the Moxgate files examined.
- "Explain at the point of block" (design addition 5, "Community Rule 1."), mute UI: adopter-side chat code, not HTTP.

## 6. Suggested split for the plan
1. Kit HTTP prerequisites (small): browser-safe `./admin` subpath + remove Buffer/node:crypto (section 4). Decide per gap: add routes for sanction groups on history (+linked counts), term metadata
   (note/addedBy/updatedAt/blocks30d), `ReportSummary.targetHandle`, reporterRecord/reportingSuspendedUntil, `GET /recent`, `GET /blocked`, `POST /terms/test`, whoami/permissions, or explicitly cut those panels from v1.
2. hub-react core: transport-injected API client typed from `@chatwarden/http`/`core` types (type imports only), port `useModData`/`useModAction`, `t` prop + en catalog, `--cw-*` CSS, router adapter, role-gated tabs.
3. Screens: Overview (grouping fn), Reports queue (+paging), Report page + DecisionPanel (rewrite: decide/rule/lineIds/evidence/suggest), Player history (blocked on sanction-group gap), Terms (check then save), Gaps (new), Audit (cursor), Guide/Policy.
4. Tests: port modView.test.ts (713) as pure tests; port ModeratorHub.test.tsx (1018), ModWork.test.tsx (944), ModGuide.test.tsx (230) against a fake transport wrapping the real `adminRoutes` + MemoryStore (doubles as the demo's integration proof).
5. player-react (separate package): ReportDialog, NoticeDialog/Toast, MyRecord, RulesPage, RestrictedChatLine.
