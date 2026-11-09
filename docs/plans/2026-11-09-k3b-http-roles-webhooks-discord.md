# Chatwarden K3b: HTTP layer, roles, audit, webhooks, Discord feed. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a moderation team and a game client need over HTTP, with no hand-written routes:
- a staff admin API with roles and per-action permissions
- an audit trail of every staff action and evidence view
- player APIs (notices, record, rules)
- signed webhooks out and in
- a Discord forum review feed
- a name check
- health endpoints

The K4 hub and service mode are built on top of this.

**Architecture:**
- `@chatwarden/http` holds framework-neutral handlers (`(req: KitRequest) => Promise<KitResponse>`), a tiny router and an Express adapter. Handlers only call the `Chatwarden` facade, never the store.
- Auth is the adopter's: they supply `authorize(req) → { actor, role } | null`. The kit enforces roles.
- `@chatwarden/discord` subscribes to facade events. A small event emitter on the facade is added here.

**Tech Stack:** as K3a. Adds `express` as a peer of `@chatwarden/http`'s adapter, plus `undici`/global `fetch` (Node ≥ 22) for webhooks and Discord.

**Spec:**
- `docs/design/2026-11-09-chatwarden-design.md` (Roles, the webhooks adapter, Discord)
- `docs/design/2026-11-09-product-scope.md` §3 (roles, audit, notifications), §8 (HTTP, webhooks, observability)

**Reference (read-only):** `C:\dev\moxgate\server\moderation\{modAdminRoutes,discordFeed,forumClient}.ts` and their tests.

**Builds on (main `58c9909`):** the facade surface `rooms`, `chat`, `mutes`, `reports.{submit,list,get}`, `doors`,
`sanctions.{apply,revoke}`, `rules`, `profile`, `limits`, `summary`, `documents`, `notices.*`, `decide`, `history`,
`suggest(subject, level, rule, {roomId})`, `gaps.{list,close}`, `purge`, `flush`, `close`. Plus `kit_audit`
(migration 2) and LiveTerms (matcher).

## Global Constraints

Everything in the K1, K2 and K3a Global Constraints binds. Plus:

- **No identifier in a player response, ever.** Staff responses may carry subject ids (staff-only), but never
  key hashes, IP hashes or raw keys.
- **Every staff request is authorized and audited.**
  - The audit records `{ at, actor, role, action, target }`, where target is a report id, group id, staff ref or
    term id.
  - Viewing a report's evidence (`GET /reports/:id`) is audited.
  - The audit never stores chat text, reasons, evidence notes or gap notes. It stores only ids and the action
    name.
- **Error mapping:**
  - `ReportQueryError`, `RangeError`, `ProfileError`, `SanctionError`, `RulesError` and validation errors → 400
    `{ error: <code>, message: <fixed text> }`
  - unknown id → 404
  - not authorized → 401
  - lacking permission → 403
  - anything else → 500 `{ error: 'internal' }`, logged with the error class only
  - A message never echoes request input.
- **Bodies:** JSON only, capped at 64 KiB (413 above). A query `limit` is parsed as an integer.
- **Webhooks:**
  - HMAC-SHA256 over `${timestamp}.${body}`, sent as headers `x-chatwarden-timestamp` and `x-chatwarden-signature`
    (`v1=<hex>`)
  - incoming requests are rejected outside a ±5 minute window, and replays (the same signature) are refused
    within it
  - delivery retries: 5, with exponential backoff
  - payloads carry staff refs and ref codes, never chat text unless the adopter opts in with `includeExcerpts`
- **Discord:**
  - no chat text by default
  - posts carry ref codes, rule numbers, conduct level / AI severity when present, and hub links built from an
    adopter template
  - never subject ids in visible text; they may appear only inside the link URL
- **Suggest calls pass `roomId`.** The admin `suggest` endpoint takes `reportId` and derives the roomId from the
  report, so relaxed note escalation works (K3a finding).

## Review Focus

1. **Privilege escalation:**
   - a moderator calling an owner-only route (permanent ban, settings) gets 403
   - a forged or missing auth gets 401
   - role checks happen before any side effect
2. **Data leaks across the boundary:**
   - the player routes never return a staff field
   - the audit and webhooks never carry chat text by default
   - Discord visible text never holds an id
3. **Webhook replay and forgery:** a wrong signature, a stale timestamp, a replayed signature or a body changed after
   signing → 401, with no action applied.
4. **Idempotency through HTTP:** a double-submitted decide is a replay, never two sanctions. A webhook-in
   apply-action retried 5 times applies once.
5. **Hostile input:** oversized bodies, non-JSON, prototype-pollution keys (`__proto__`), huge `limit`, path
   traversal in ids. All are rejected cleanly.

---

### Task 1: Facade events and the names API

**Files:**
- Create: `packages/core/src/events.ts`
- Modify: `packages/core/src/{chatwarden.ts,index.ts}`
- Test: `packages/core/test/events.test.ts`, `packages/core/test/chatwarden.test.ts`

**Interfaces:**
- Produces:
  - `type KitEvent` =
    - `{ type: 'report.created'; reportId; createdAt; category; roomTags }`
    - `{ type: 'report.closed'; reportId; verdict; at }`
    - `{ type: 'sanction.applied'; groupId; refCode; kind; until; rule; source; automated; target: StaffRef }`
    - `{ type: 'sanction.revoked'; groupId; refCode; at }`
    - `{ type: 'gap.created'; groupId; refCode; at }`
    - `{ type: 'auto.restricted'; groupId; refCode; second: boolean }`
  - `StaffRef` = the canonical subject id. Events are staff-only.
  - `cw.on(type | '*', listener): () => void` (an unsubscribe function).
  - Listeners are fenced (sync throws and async rejections are logged with the error class) and are called after
    the commit.
  - Wire the emit points: `reports.submit` ok, `decide` (closed + every applied group + gaps), `sanctions.apply` and
    `sanctions.revoke`, and ChatService auto-restrict via `onAutoRestrict`, keeping the existing option.
  - `cw.names.check(text: string): { ok: true } | { ok: false; reason: 'name_not_allowed'; rule: number }`. It uses
    the facade matcher via matcher `nameViews`/`matchName` semantics.
    - Core can't import matcher, so add an optional `Matcher.matchName?(name)` to the core structural `Matcher`,
      implemented by matcher's `buildMatcher` and LiveTerms.
    - Without `matchName`, it falls back to `match(name)`.
    - `rule` = `autoRestrictRule`.

- [ ] **Step 1: Write failing tests:**
  - each event fires once with the documented shape after the commit
  - no event on a refused or failed operation
  - a throwing or rejecting listener is fenced
  - `'*'` receives everything
  - unsubscribe works
  - events carry no chat text, reason, evidence or gap note (scan the serialized form)
  - `names.check` blocks the synthetic term in handle forms (`Zorbak_99`) and passes clean names
  - with no matcher, `names.check` returns ok
- [ ] **Step 2: Run** `npx vitest run packages/core/test/events.test.ts packages/core/test/chatwarden.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): facade events and names.check`.

### Task 2: Staff audit

**Files:**
- Create: `packages/core/src/audit.ts`
- Modify: `types.ts` (Store `insertAudit`, `listAudit`), memoryStore, sqliteStore, migration 12 (`kit_audit` gains a
  `role` column and an index on `at`), `chatwarden.ts`
- Test: `packages/core/test/audit.test.ts`, `packages/store-sqlite/test/audit.store.test.ts`

**Interfaces:**
- Produces:
  - `cw.audit.record({ actor, role, action, target? })`: sync, fenced, and logs on failure. `action` is from a closed
    union exported as `AUDIT_ACTIONS`:
    - `report.view`
    - `report.decide`
    - `sanction.apply`
    - `sanction.revoke`
    - `gap.close`
    - `term.add`, `term.update`, `term.toggle`, `exception.add`, `exception.update`, `exception.toggle`
    - `history.view`
    - `suggest`
    - `policy.view`
  - `cw.audit.list({ before?, limit, actor?, action? }) → { items, next }` with the keyset pattern from K3a reports.
  - The existing term audit rows (K1 LiveTerms) stay readable in `list`. Map their `action` into the union, or
    show them as `term.*`.
  - Never stores text.
  - Retention: audit rows are kept for 1 year (`retention.auditMs`, default 365 d, floor 90 d) and purged in
    `purge`.

- [ ] **Step 1: Write failing tests:**
  - record and list round-trip
  - filters
  - paging ties
  - an unknown action is refused
  - the scan finds no text fields
  - migration 12 keeps old rows
  - purge at 365 d
  - both stores agree
- [ ] **Step 2: Run** the listed tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): staff audit trail`.

### Task 3: `@chatwarden/http` core (router, errors, auth, roles)

**Files:**
- Create: `packages/http/{package.json,tsconfig.json,src/index.ts,src/router.ts,src/errors.ts,src/auth.ts,src/permissions.ts,test/router.test.ts,test/permissions.test.ts}`
- Modify: root tsconfig and vitest config

**Interfaces:**
- Produces:
  - `interface KitRequest { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; rawBody?: string }`
  - `interface KitResponse { status: number; headers?: Record<string, string>; body: unknown }`
  - `type Role = 'moderator' | 'senior' | 'owner'` (ordered).
  - `PERMISSIONS: Record<PermissionKey, Role>`, the minimum role per action. Defaults:
    - `reports.read` moderator
    - `reports.decide` moderator
    - `sanctions.apply` moderator
    - `sanctions.apply.ban_permanent` senior
    - `sanctions.revoke` moderator
    - `history.read` moderator
    - `gaps.read` moderator
    - `gaps.close` owner
    - `terms.read` moderator
    - `terms.write` moderator (the Moxgate decision)
    - `policy.read` moderator
    - `audit.read` senior
    - `settings` owner
  - Configurable via `permissions?: Partial<...>`, validated (a valid role).
  - `createRouter(routes)` matches `METHOD /path/:param`. Params must match `^[A-Za-z0-9_-]{1,64}$`, else 404.
  - `withErrors(handler)` applies the Global Constraints error mapping.
  - `parseJson(rawBody, max = 65536)` throws 413/400. A prototype-pollution key anywhere → 400.
  - `requireRole(authz, permission, permissions)` → 401/403.

- [ ] **Step 1: Write failing tests:**
  - routing and params
  - a bad param → 404
  - each error class → its status, with a fixed message that doesn't echo the input
  - body cap 413
  - non-JSON → 400
  - `__proto__` / `constructor` keys → 400
  - the role order (owner ≥ senior ≥ moderator)
  - a permission override
  - 401 vs 403
  - role checks happen before the handler runs (a spy handler is not called)
- [ ] **Step 2: Run** `npx vitest run packages/http/test`. Expected: FAIL.
- [ ] **Step 3: Implement.** No runtime dependency other than `@chatwarden/core` (types).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): router, errors, auth and role permissions`.

### Task 4: Admin routes, reports and decisions

**Files:**
- Create: `packages/http/src/admin/reports.ts`, `packages/http/test/admin.reports.test.ts`
- Modify: `packages/http/src/index.ts`

**Interfaces:**
- Consumes: Task 3 helpers, Task 2 `cw.audit.record`.
- Produces `adminRoutes(cw, { authorize, permissions? })` routes (staff-only), each audited:
  - `GET /reports?status&cursor&limit` → `cw.reports.list`
  - `GET /reports/:id` → `cw.reports.get`, plus per person `history` (recent actions) and `suggest` for the
    reported person at the report's category → rule via `CATEGORY_TO_RULE`, with `{ roomId }` from the report.
    `level` comes from the `?level=` query or defaults to null. Audited as `report.view`.
  - `POST /reports/:id/suggest { level, rule?, person? }` → the suggestion (person defaults to the target; the
    roomId comes from the report)
  - `POST /reports/:id/decide { verdict, actions, reason, evidence? }` → `cw.decide`
    - `actor` = authz.actor, never from the body
    - a permanent ban action requires `sanctions.apply.ban_permanent`
    - the response is `{ ok, replay, groups: [{ refCode, kind }] }`
  - `GET /people/:ref/history` → `cw.history(ref)`, plus a recent-reports summary (ids, dates and categories from
    `reports.list` filtered by person). If the store lacks person filtering, add a Store method
    `listReportsByPerson(ref, limit)`.

- [ ] **Step 1: Write failing tests:**
  - each route's happy path with an in-memory facade
  - 401 and 403 per route
  - the decide actor taken from authz, with a body actor ignored
  - a permanent ban needs senior
  - a double decide replays (Review Focus 4)
  - every response contains no key or IP hash (scan)
  - each route writes its audit row
  - `GET /reports/:id` passes the roomId into suggest (a spy facade)
- [ ] **Step 2: Run** `npx vitest run packages/http/test/admin.reports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): admin report and decision routes`.

### Task 5: Admin routes, sanctions, gaps, terms, policy, audit

**Files:**
- Create: `packages/http/src/admin/{sanctions,gaps,terms,policy,audit}.ts` and tests
- Modify: `packages/http/src/index.ts`

**Interfaces:**
- Produces, added to `adminRoutes(cw, { authorize, permissions?, terms?: LiveTerms })`:
  - `POST /sanctions { subject, kind, durationMs, rule, gapNote?, includeIp? }` → `cw.sanctions.apply` with
    `source: 'moderator'`, the actor from authz, and the permanent-ban permission
  - `POST /sanctions/:groupId/revoke { reason }`
  - `GET /gaps` and `POST /gaps/:groupId/close { status, ref }`. `status` is validated, and when `status` is
    `ruled`, `ref` must be an active CR number in `cw.rules` (the K3a deferred item).
  - Terms routes, only if `terms` is passed:
    - `GET /terms` (rows, staff-only)
    - `POST /terms/check { term, language }` → `liveTerms.check`
    - `POST /terms`, `PATCH /terms/:id` and `POST /terms/:id/active`, plus the same for exceptions, mapped to
      `liveTerms.change`
    - errors map to 400 and never echo the term
  - `GET /policy` → `{ profile, rules, summary, documents: { codeOfConduct, moderatorGuide, agentBrief } }`
  - `GET /audit?cursor&limit&actor&action` (senior)

- [ ] **Step 1: Write failing tests:**
  - each route
  - permissions (gaps.close owner, audit.read senior, terms.write moderator, and overrides)
  - the gap ref validated against the rules
  - term errors never echo the term
  - audit rows
  - no hash leaks
- [ ] **Step 2: Run** `npx vitest run packages/http/test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): admin sanctions, gaps, terms, policy and audit routes`.

### Task 6: Player routes and health

**Files:**
- Create: `packages/http/src/player.ts`, `packages/http/src/health.ts` and tests

**Interfaces:**
- Produces `playerRoutes(cw, { identify: (req) => RawWho })`. `identify` is the adopter's; it reads the
  client token or session.
  - `GET /notices` → `cw.notices.pending`
  - `POST /notices/:id/ack`
  - `GET /record`
  - `GET /rules` → `{ summary, rules: active rules }`
  - `GET /code-of-conduct?format=html|markdown|text` (HTML gets the CSP and nosniff from tiny-chat)
  - `POST /names/check { name }` → `cw.names.check` (rate-limited per identity: 20/min, configurable)
- Produces `healthRoutes(cw)`:
  - `GET /healthz` → 200 `{ ok: true }`
  - `GET /readyz` → 200 when the store answers `schemaVersion()`, else 503

- [ ] **Step 1: Write failing tests:**
  - every player response matches the player shapes exactly (no staff field; a scan for subject ids, hashes and
    room ids)
  - ack by a non-target → false
  - unknown or IP-only identity → empty
  - the names rate limit
  - code-of-conduct headers
  - health and ready (a store that throws → 503)
- [ ] **Step 2: Run** `npx vitest run packages/http/test/player.test.ts packages/http/test/health.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): player routes and health endpoints`.

### Task 7: Express adapter, and tiny-chat on the kit routes

**Files:**
- Create: `packages/http/src/express.ts`, `packages/http/test/express.test.ts`
- Modify: `examples/tiny-chat/{server.ts,tiny-chat.test.ts,README.md}`

**Interfaces:**
- Produces `toExpress(routes, opts?: { maxBody?: number })`, which returns an `express.Router`.
  - It reads the raw body itself (no `express.json` needed) so webhooks can verify signatures.
  - It maps `KitResponse` to `res`.
  - `express` is a peerDependency.
- tiny-chat:
  - replace its hand-written `/decide`, `/record` and `/code-of-conduct` routes with
    `toExpress(adminRoutes(...))` under `/admin` (authorize via the demo admin token, role owner) and
    `toExpress(playerRoutes(...))` under `/api`
  - keep the WebSocket chat
  - keep the existing integration behaviours, with URLs updated in the tests and README

- [ ] **Step 1: Write failing tests:**
  - the adapter (status, headers and body; body cap; raw body available)
  - the tiny-chat flows through the new routes, including the leak scan with its positive control
- [ ] **Step 2: Run** `npx vitest run packages/http/test/express.test.ts examples/tiny-chat/tiny-chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): Express adapter; tiny-chat uses the kit routes`.

### Task 8: Signed webhooks, out and in

**Files:**
- Create: `packages/http/src/webhooks/{sign.ts,out.ts,in.ts}` and tests

**Interfaces:**
- Produces:
  - `sign(secret, timestamp, body): string` (`v1=<hex>`) and `verify(secret, headers, rawBody, now, seen: ReplayCache): boolean`.
    - The comparison is constant-time.
    - The window is ±300 s.
    - `ReplayCache` is an LRU of signatures (10 000).
  - `webhooksOut(cw, { endpoints: Array<{ url; secret; events: KitEvent['type'][] | '*'; includeExcerpts?: false }>, fetch?, clock? })`
    - subscribes via `cw.on`
    - POSTs the JSON event with signature headers
    - retries 5 times with exponential backoff (1 s base, jitter), using an in-memory queue
    - `dispose()`
    - failures are logged with the class only
    - excerpts are never included unless `includeExcerpts`, which adds the report excerpt for `report.created`
  - `webhookIn(cw, { secret, actor: string })` is a route `POST /webhooks/in/action`. It verifies the signature,
    then accepts `{ action: 'decide', input: DecisionInput }` or `{ action: 'sanction', input: SanctionInput }`.
    - The actor is forced to the configured actor.
    - Through decide, it is idempotent.
    - A `sanction` input must carry `idempotencyKey`. The same key within 24 h returns the first result. Store it in
      a new `kit_webhook_keys` table (migration 13), purged after 24 h.

- [ ] **Step 1: Write failing tests:**
  - sign and verify round-trip
  - a wrong secret, a stale timestamp, a changed body or a replayed signature → 401 (Review Focus 3)
  - retries with a fake fetch and fake timers, stopping after 5
  - the event filter
  - no excerpt by default
  - a webhook-in decide replayed 5 times applies once
  - a sanction with the same idempotencyKey applies once
  - a missing key → 400
- [ ] **Step 2: Run** `npx vitest run packages/http/test/webhooks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(http): signed webhooks out and in`.

### Task 9: `@chatwarden/discord`

**Files:**
- Create: `packages/discord/{package.json,tsconfig.json,src/index.ts,src/forum.ts,src/feed.ts,test/feed.test.ts}`
- Modify: root tsconfig and vitest config

**Interfaces:**
- Produces `discordFeed(cw, { webhookUrl, hubLink: (kind: 'report' | 'person', id: string) => string, mentionRoleId?: string, severeOnly?: false, fetch? })`.
  - The model is Moxgate's `discordFeed` + `forumClient`:
    - one forum thread per reported person, created on their first report (thread name = a neutral label such as
      "Report M-ABC12", never a handle or id)
    - later reports and outcomes post into that thread
  - `report.created` posts the category, rule, conduct level (if known; K3c adds the AI tag) and a hub link.
  - `sanction.applied` / `report.closed` post the outcome with its ref code.
  - `auto.restricted` posts an "Automatic timeout" line.
  - `mentionRoleId` pings the role on severe (`category: 'hate'` or rule ∈ `profile.severeRules`).
  - It keeps a thread map per person, in memory plus the store (`kit_discord_threads`, migration 14), so it survives a
    restart.
  - Rate limits: honour 429 `retry_after`.
  - Visible text never contains a subject id or hash. Ids appear only in the URLs `hubLink` builds.

- [ ] **Step 1: Write failing tests** with a fake fetch:
  - thread created once per person, then reused (also after a restart via the store)
  - post contents for each event
  - no chat text
  - no id in visible text (scan the `content` and embed fields; links excluded)
  - the role mention on severe only
  - 429 retry
  - a throwing fetch fenced
- [ ] **Step 2: Run** `npx vitest run packages/discord/test`. Expected: FAIL.
- [ ] **Step 3: Implement**, porting behaviour from Moxgate (read its tests for the cases) but generic.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(discord): forum review feed`.

### Task 10: Integration, docs, CI

**Files:**
- Create: `packages/http/README.md`, `packages/discord/README.md`
- Modify: root README, `examples/tiny-chat` (optional Discord feed when `DISCORD_WEBHOOK_URL` is set)
- Test: `packages/http/test/integration.test.ts`

**Interfaces:**
- An end-to-end test over Express:
  1. a player reports
  2. the staff list → get (audited) → decide a warning
  3. the player's `GET /notices` shows it, then ack, then `/record`
  4. revoke → gone
  5. a webhook endpoint (a local http server) receives a signed `report.created` and `sanction.applied` and
     verifies them
  6. the Discord fake receives the thread and its posts
- A leak scan across every player response, webhook body and Discord visible text, with a positive control.

- [ ] **Step 1: Write the failing integration test.**
- [ ] **Step 2: Run** `npx vitest run packages/http/test/integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and docs (the READMEs show copy-paste setup: `adminRoutes`, `playerRoutes`, `toExpress`, `webhooksOut`, `discordFeed`).
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and lint are clean.
- [ ] **Step 5: Commit and push.** CI is green on both legs.
