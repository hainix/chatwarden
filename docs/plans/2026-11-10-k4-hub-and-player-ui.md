# K4: the moderator hub (`@chatwarden/hub-react`) and player UI (`@chatwarden/player-react`) (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers of UI tasks MUST load the `frontend-design:frontend-design` skill before any UI work.

**Goal:** Ship the moderator hub that the landing page says "is coming". Two new published React packages: `hub-react`
(the staff hub over `@chatwarden/http`'s staff API) and `player-react` (notices, "my record", rules, report dialog,
restricted-chat line). Add the few staff read routes the hub needs. Then the site demo's moderator pane becomes the real hub
running the real staff routes in the browser, and the "Hub UI is coming" tag comes off.

**Architecture:**
- `hub-react` talks to the staff API only through an injected **transport**:
  `(req: { method; path; query?; body? }) => Promise<{ status: number; headers: Record<string,string>; body: unknown }>`.
  `fetchTransport({ baseUrl, headers?, credentials? })` is the default for real apps. The site demo passes
  `routerTransport(createRouter(adminRoutes(cw, …)))`, which runs the real routes in the browser. The hub cannot tell the
  two apart, so the demo proves what adopters ship.
- `@chatwarden/http` gains a browser-safe subpath `@chatwarden/http/admin` (router, errors, auth, permissions, admin
  routes; no player or webhooks code, no `node:` import, no `Buffer`), covered by `scripts/browser-bundle.test.ts`.
- The starting point is Moxgate's ops hub (`C:\dev\moxgate\deploy\ovh\ops\ui\src\moderation\*`). It is a reference for
  behaviour and layout, NOT a straight port: the kit API is atomic, cites Community Rules and is role-gated.
- The research map with every field name, route shape and gap is
  `docs/plans/k4-research-hub-mapping.md` (copied from the controller's research). Implementers read the sections it names.

**Tech Stack:** React (peer `^18.3.0 || ^19.0.0`), TypeScript strict ESM, plain CSS with `--cw-*` custom properties (no
UI kit, no CSS-in-JS), vitest + jsdom + @testing-library/react + user-event, and axe-core for accessibility checks in tests.
No router library: a tiny hash router with an adapter prop. No data library: small `useHubData` / `useHubAction` hooks.

**Spec:** docs/design/2026-11-10-hub-workbench-and-teams.md (the workbench, team claims, the look; it governs Tasks 4b onward and
the restyle of earlier screens), docs/design/2026-11-09-chatwarden-design.md (packages table, "Two review backends", AI provenance rules, K4,
K8 demo), docs/design/2026-11-09-feature-contract-from-moxgate.md (the hub's screens and player notices), and the owner's
direction on 2026-11-10: "it says 'hub ui is coming' from the website, do any remaining work to have this be fully
feature complete".

## Global Constraints

- Both packages are **published** and join the changesets `fixed` group. Versioning: one **patch** changeset for the group
  (0.1.1 → 0.1.2). Not a minor: in 0.x a minor leaves every existing `^0.1.x` peer range out of range, and changesets would
  then bump the dependents a major. The new work is additive. Task 9 runs `npx changeset version` in the branch, as K8a did. Each new package gets README, LICENSE, `files`, `exports`
  with types, `sideEffects` listing only its CSS, `prepack: tsc -b`, a VERSION constant synced by `scripts/sync-version.mjs`,
  and an entry in `scripts/publish-order.mjs` and `scripts/check-pack.mjs` (both browser-safe).
- `react` and `react-dom` are **peerDependencies** only; never bundle React. `@chatwarden/core` and `@chatwarden/http` are
  peer `^0.1.1` while building (the workspace is at 0.1.1) and raised to `^0.1.2` by Task 9 once
  `changeset version` has run, for hub-react (core and http) and player-react (core). Use type-only imports where possible.
- **No identifiers leak to players.** player-react shows only what `GET /notices` / `GET /record` return. The hub shows
  opaque person refs as a short tag (first 8 characters), never `a:`/`k:` refs, accounts, keys or IPs.
- **i18n:** every user-visible string comes from a keyed English catalog (`hub.*`, `player.*`) through a `t(key, params)`
  prop. The default is English, with `{name}` interpolation and plurals via `Intl.PluralRules`. Times use
  `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` with a `locale` prop. No hard-coded English in components.
- **Theming and CSP:** each package ships one CSS file (`@chatwarden/hub-react/styles.css`,
  `@chatwarden/player-react/styles.css`). Every colour, radius, font and space is a `--cw-*` variable with light and dark
  defaults (`prefers-color-scheme`, overridable with `[data-cw-theme="light|dark"]`). All rules are scoped under `.cw-hub` or
  `.cw-player`. No inline `<style>`, no injected styles, no `dangerouslySetInnerHTML`. Generated policy documents are
  rendered as text/markdown through a tiny safe renderer (headings, paragraphs, lists, emphasis; everything else escaped).
- **Accessibility:** semantic landmarks, every control labelled, visible focus, keyboard-operable everything, dialogs that
  trap and restore focus, `aria-live` for action results. axe in tests reports no serious or critical issues for every screen
  in both themes.
- **Honesty:** AI levels are not built. The hub has the provenance label slot (`source: 'ai'` shows "AI"), but no AI controls.
  Moxgate-only things (seats p1–p6, team chat, Discord forum links, MOD_OFF, `enforced`, "slur list" wording) are dropped or
  turned into props.
- **Tests:** test-first, red then green, with broad cases (variants, edge cases, controls). UI tests run against the
  **real** `adminRoutes` over `@chatwarden/store-memory` through `routerTransport`, not hand-written fakes, except where a
  test needs an error the real routes can't produce (a network failure or a 500). Run only targeted tests:
  `npx vitest run <paths>` and the package's own `npm test --workspace <pkg>`. **Never run the full repo suite.**
- **Size:** `hub-react` JS stays under 60 KB gzip and `player-react` under 15 KB gzip, measured by a size test in each
  package (esbuild, React external). `@chatwarden/http/admin` must stay in the browser-bundle budget.
- Copy is plain and short, written for indie game moderators.

## Review Focus

1. **The real routes.** Every hub screen's tests drive the real `adminRoutes` + MemoryStore. A decided report actually
   applies the sanction, and the person page shows it with a working Revoke.
2. **Roles.** A `moderator` doesn't see Audit or Permanent ban, and can't close gaps. A `senior` sees Audit and Permanent.
   An `owner` can close gaps. A 403 from the server shows a plain message, not a crash.
3. **Errors and replays.** A double-click on Decide sends one decision (or replays harmlessly). A 409 `already_decided`
   reloads the report and says so. A network failure keeps the form's input and offers Retry.
4. **Phone width.** At 360px the hub stays usable: the queue becomes cards, the report page stacks, and tables scroll
   inside their own box.
5. **Leaks.** The hub never shows a raw person ref longer than the 8-character tag. player-react never shows another
   person's text, id or IP (only the excerpt lines the API returns).

---

### Task 1: `@chatwarden/http/admin` browser subpath, and `GET /me`
- In `packages/http`:
  - Replace `Buffer.byteLength` in `src/body.ts` and `src/webhooks/in.ts` with a `TextEncoder` byte length.
  - Move `sanctionFingerprint` and its `node:crypto` import out of `src/admin/apply.ts` into `src/webhooks/` (or compute it
    with core's isomorphic hasher). Its consumer is `webhooks/in.ts`.
  - Add `src/admin-entry.ts`, exported as `@chatwarden/http/admin` (with `typesVersions`). It re-exports `adminRoutes`,
    `createRouter`, `compileRoutes`, `HttpError`, the role, permission and types exports, and nothing from `player.ts`,
    `webhooks/*` or `express.ts`.
  - Add `GET /me` to `adminRoutes`. It returns
    `{ actor: string, role: Role, can: Record<PermissionKey, boolean> }` from the request's `authorize` result and the
    effective permission table (`permissions` option overrides included). It needs no permission beyond being authorized
    (401 otherwise). It writes no audit row.
- Add `@chatwarden/http/admin` to `scripts/browser-entry.ts`. The existing no-`node:`/vm test must cover it, and the
  budget is raised only by what the subpath measures, plus a stated margin.
- Tests:
  - the body-size limit gives a 413 at exactly the limit + 1 byte for ASCII, multi-byte and astral input, and a 200 under it,
    in a context with no `Buffer` global
  - the webhook fingerprint is byte-identical before and after the move (pin a golden value)
  - `GET /me` for each role, with permission overrides, and 401 with no or malformed authz
  - the subpath bundles for the browser with no `node:` specifier and runs in the vm context

### Task 2: Staff read routes the hub needs
Rule on each gap in the research map's section 1. All are additive, keep existing responses byte-compatible apart from
new fields, and are implemented in core facade + both stores (store-sqlite with a migration if needed, store-memory) + the
shared store contract suite + http:
- **Sanction groups.**
  - `GET /people/:ref/history` gains `sanctions: SanctionGroupView[]` (newest first, the same 90-day window plus every
    active permanent one).
  - `SanctionGroupView = { groupId, refCode, kind, rule: RuleRef|null, startsAt, endsAt: number|null, reason, actor, source, automated, active: boolean, revokedAt: number|null, revokedBy: string|null, revokeReason: string|null }`.
  - The subject row is the only one used. No IP or value is ever returned.
- **Recent actions.** `GET /sanctions?cursor&limit&source` lists `SanctionGroupView & { person: SubjectId }` across all
  people, newest first, cursor-paged (limit 1..200, default 50). Permission `history.read`.
- **Reporter record.** The history response gains
  `asReporter: { reports, open, actioned, dismissed, badFaith, suspendedUntil: number|null }`, using core's existing
  suspension logic.
- **Blocked messages.** `GET /blocked?days=1|7|30` returns
  `{ items: [{ id, at, roomId, termId, term|null, language|null, person, text }] }` from strikes (newest first, max 500).
  It is staff-only, with a new permission `blocked.read` (moderator). It writes an audit row `blocked.view`. Staff already see
  raw lines in report excerpts, so this is not a new exposure. State it in the http README.
- **Term metadata.** `GET /terms` rows gain `note, addedBy, addedAt, updatedBy, updatedAt`, and the response gains
  `blocks30d: Record<termId, number>` (strike counts). `AdminRoutesOptions.terms` widens structurally. `LiveTerms` already
  has the data.
- **Message tester.** `POST /terms/test { text }` → `{ verdict: 'blocked'|'clean'|'too_long', termId: string|null }`. It
  is side-effect free: no strike, no audit, no rate charge. Permission `terms.read`. It is mounted only with `terms`.
- **Queue names.** `GET /reports` items gain `targetHandle: string|null`, the handle on the reported person's latest
  excerpt line at filing time. It is staff-only, consistent with the report page.
- Tests: each route's happy path, paging edges (empty, exactly one page, cursor past the end, bad cursor 400), the role
  gates, the no-IP rule (a test asserts no hashed IP or `value` field appears anywhere in the JSON), the audit rows,
  store-contract parity between sqlite and memory, and a 0.1.x-shaped database migrating cleanly.

### Task 3: hub-react foundation and shell
- Create `packages/hub-react` with the package rules in Global Constraints.
- `src/transport.ts`: `Transport`, `fetchTransport`, and `routerTransport(handle)`. `routerTransport` builds a
  `KitRequest` with `rawBody: JSON.stringify(body)` when there is a body. JSON responses parse, and string bodies pass
  through.
- `src/client.ts`: a typed `HubClient` with one method per staff route, using response types from `@chatwarden/http` /
  core (type imports). A `HubError { status, code, message, retryAfter? }`. Cursor helpers.
- `src/hooks.ts`: `useHubData(key, load)` (stale-answer guard, keeps last good data on a failed reload) and
  `useHubAction()` (busy/error, an in-flight guard so a double submit sends once).
- `src/i18n.ts`: `en` catalog object, `createT(catalog, locale)`, `HubText` type of keys, plurals.
- `src/router.ts`: hash routes (`#/`, `#/reports`, `#/reports/:id`, `#/people/:ref`, `#/terms`, `#/blocked`, `#/gaps`, `#/audit`, `#/guide`) with a `router` prop (`{ path, navigate }`) so an adopter can use their own router. A memory router is
  used in tests and the demo.
- `src/Hub.tsx`: `<Hub client t? locale? router? theme? onNavigate? />`.
  - Loads `GET /me` and hides the tabs the role can't use.
  - Header plus tabs: Overview, Reports, Blocked, Terms, Rule gaps, Audit (senior and up), Guide.
  - A plain full-hub message for 401/403 on `/me`.
- `styles.css`: the `--cw-*` token contract, light and dark, the base layout, buttons, tags, tables that scroll in their own
  box, and the focus ring. DESIGN notes go in the README's "Theming" section.
- Screens in this task:
  - **Overview:** the stats strip computed from the queue (people waiting, reports, longest wait), Needs review (top 5
    groups), and Recent actions (from `GET /sanctions`, first 10).
  - **Reports queue:** grouped by `targetPerson` with a pure `groupQueue()` function; status segment
    (open/actioned/dismissed/all); follows `next` with "Load more"; rows show the handle (or the person tag), categories,
    report count, rooms, reporters and latest time.
- Tests:
  - pure tests for `groupQueue`, `createT` (plurals, a missing key falls back to the key, params), and the router parse/build
    round trip
  - transport tests for both transports (status, string bodies, errors)
  - render tests against real routes:
    - tabs per role
    - the queue grouping with 0, 1 and 60+ reports, paged
    - Overview numbers
  - axe on each screen, light and dark
  - a size test

### Task 4: Report page and decision panel
- **`ReportView`** (`#/reports/:id`): meta (category, time, room, tags), reporter and reported (handle and tag), the note,
  and the excerpt. In the excerpt, the reported line is marked, blocked lines are struck through, there's a "Only <name>"
  filter and a "<name> sent no messages" warning. People are derived from the excerpt and `people[]`. It also shows the
  person's record line (from `history`) and the reporter record (from Task 2), with a link to each person page.
- **`DecisionPanel`**, a rewrite against `POST /reports/:id/decide`:
  - Verdict: Fair (`upheld`, or `noted` when every action is a note), Not a problem (`no_action`), Bad faith (`bad_faith`,
    which requires an evidence text box of 1..500 characters).
  - The ladder suggestion banner from the report response. A conduct level picker (`banter|rude|hostile|severe`)
    recomputes it via `POST /reports/:id/suggest`.
  - Per-person actions: presets from core's `LADDER_TABLE` plus "Something else" (kind
    chat/area/ban/warning/note × duration 1h/24h/7d/30d/permanent). Permanent is shown only when `can['sanctions.apply.ban_permanent']`. The target can only be acted on with an upheld/noted verdict. Others (reporter, other people) can be
    added, up to 20 actions.
  - A Community Rule picker per action, from `GET /policy` rules (active only), plus "No rule covers this", which requires a
    gap note of up to 500 characters.
  - An own-lines picker per action (≤5 of that person's own lines, from `ownLineIds`), labelled "Show the player these
    lines".
  - The reason, required, ≤500 characters, with a counter.
  - Submit sends one call with an idempotency key per form instance. Show the result's ref codes. A `replay:true` result is
    a success. A 409 `already_decided` reloads and says "Someone already decided this report". 400 codes map to field
    messages, and a network error keeps the input and offers Retry.
- Tests:
  - every verdict × action combination the server accepts or refuses, with the UI preventing what the server refuses
  - bad-faith evidence required
  - a gap note required for "uncovered"
  - the 5-line limit
  - the permanent option per role
  - a double submit sends once
  - replay
  - the 409 path
  - the network-failure retry keeping input
  - an end-to-end check: decide → the sanction is visible in the person's history → the player's `GET /notices` (via
    `playerRoutes` in Node) shows the chosen excerpt
  - keyboard-only completion
  - axe

### Task 4b: Team routes in the kit (claims, take next, change token, viewing, saved reasons)
Per the addendum's "What the kit adds". Core facade + both stores + contract suite + http routes + browser-safe subpath, like Task 2:
- `POST /cases/:ref/claim` (claim or heartbeat; `{ takeOver?: boolean }`; TTL 10 minutes; 409 `claimed` with `{ by, until }` when
  someone else holds it and `takeOver` is absent or not allowed), `POST /cases/:ref/release`, and `POST /cases/next { category?, filters }`
  (claims and returns the oldest unclaimed open case, or `{ case: null }`). New permission `claims.override` (senior). The audit
  trail records claim takeovers (`case.takeover`), not ordinary claims.
- `GET /reports` items and `GET /reports/:id` gain `claim: { by, since, until } | null` for the target person.
- `decide` (and direct sanctions on that person) refuse with 409 `claimed` when another moderator holds the case; deciding releases
  the caller's claim. A claim never blocks reads.
- `GET /changes?since=<token>` returns `{ token, changed: boolean }`, cheap, with no audit. The token moves on any report, decision,
  sanction, claim or gap change.
- Viewing: `POST /cases/:ref/viewing` (heartbeat, 30 s TTL, in memory only, never stored); `GET /reports` items gain
  `viewing: string[]` (actors, excluding the caller).
- Saved reasons: `GET /reasons` (moderator), `POST /reasons`, `PATCH /reasons/:id`, `POST /reasons/:id/active` (senior). Each is
  `{ id, label (≤40), text (≤500), active }`.
- Tests: concurrency (two moderators racing for the same case and for take next: exactly one wins), expiry by clock, heartbeat
  extends, release, takeover permission and audit, decide blocked and allowed, the change token on each event type and stable
  otherwise, viewing expiry, the saved-reasons role gates, sqlite and memory parity.

### Task 4c: Design system v2 and the workbench shell
Restyle the whole package to the addendum's look, and rebuild the shell as the workbench:
- New tokens (neutral base, one accent, semantic red and yellow, referee-card styles), contrast AA in both themes, the optional
  `font.css` with a subset of Instrument Sans (self-hosted woff2, OFL licence shipped), and the system font by default.
- The shell: a slim top bar (product, game name, live state, command bar, who is on), a receding section rail, and the three panes at
  ≥ 1200px, two at ≥ 820px, and stacked below that.
- The queue pane:
  - rows show the claim (you in blue, others neutral), viewing, categories and wait (red only when overdue)
  - filters (category, all/unclaimed/mine)
  - "Take next case" (N)
  - J/K
  - background refresh via `GET /changes`, with an "N new" pill
- The overview becomes the team view: who is on and their current load, the oldest wait, totals, and Recent actions.
- Everything async: skeletons, the connection-lost and reconnected banner, toasts with Undo, the command bar (Ctrl+K: people,
  reports, terms, screens), and the shortcut sheet (?). Every shortcut can be turned off with a prop, and none fires inside an input.
- Tests:
  - the refresh loop (polls while visible, backs off while hidden, the pill never reorders the list under focus)
  - claims shown per state
  - each shortcut, and that none fires while typing
  - the command bar (keyboard, results, escape)
  - the banners
  - the token and contrast static checks
  - axe, light and dark
  - size

### Task 4d: The case in the workbench
Move Task 4's report page and decision panel into the workbench's case pane, in the v2 look:
- The claim banner ("You're handling this", "Maya is handling this" with Take over for seniors, released on idle) and "Ana is viewing".
- The evidence first:
  - the transcript, with the reported line marked
  - the person's lines tinted
  - "Only <name>"
  - blocked words masked until shown (per line, or for the case)
  - line checkboxes in the margin to choose what the player sees
- The docked decision bar:
  - verdict keys 1/2/3
  - the suggestion pre-filled, with a referee card and a "Change" option that opens Task 4's full action editor
  - the rule, and saved reasons
  - "Decide and take next" (Ctrl+Enter)
  - the 5-second undo window: send at once on page hide; Undo cancels with nothing sent
- The context pane: the record with referee cards, blocked attempts, and the reporters' track records.
- Tests:
  - the claim flows (claim on open, the 409 `claimed` banner, takeover by role, release on decide)
  - undo (nothing is sent within the window, and it is sent after; page hide sends)
  - decide and take next
  - masking toggles
  - keyboard-only completion
  - axe
  - the existing Task 4 decision tests kept green

### Task 5: Person page, direct sanctions, notes and revoke
Built in the v2 look, as a case-pane view of the workbench (the person's record opens in the middle pane). Recent actions also show the person's handle (`/sanctions` items gain `handle: string|null`, the handle on their latest report).
- **`PersonView`** (`#/people/:ref`):
  - the timeline (reports about them, sanctions with kind, rule, time left, ref code, actor, source with the AI label slot,
    revoked state)
  - active sanctions, each with a Revoke button (reason required; a 404 counts as already revoked and shows as success after
    a reload)
  - the reporter record and any reporting suspension
- **`SanctionForm`:** kind, duration, rule picker or uncovered with a gap note, reason, and "include their IP for 24 hours"
  (with the kit's explanation). Permanent is role-gated.
- **Add note:** a `note`-kind sanction with a rule and the note as the reason. It shows in the timeline as a note.
- **Recent actions** (`#/` panel plus "See all" → a paged list from `GET /sanctions`, filter "Automatic only" via
  `source`).
- Tests:
  - the timeline order and states (active, expired, revoked, permanent)
  - revoke happy path, plus 404-as-success
  - a sanction from the form shows up
  - a note round trip
  - role gates
  - paging
  - the no-leak check (no string longer than the tag that matches a ref in the DOM)
  - axe

### Task 6: Terms, Blocked, Rule gaps, Audit, Guide
Built in the v2 look. Blocked words are masked by default on Blocked and Terms, the same way they are in the case.
- **Terms** (`#/terms`):
  - Terms and exceptions by language, using `Intl.DisplayNames` labels. Columns: word, note, last changed by/at, blocks in
    the last 30 days, active.
  - Add/edit form: a dry run with `POST /terms/check` first. When it reports hits, list them and require a "Save anyway"
    confirm, then POST/PATCH. A flat 400 `invalid_term` reads "The list refused this word (it may be a duplicate, malformed,
    or the last active word)".
  - Enable/disable toggles.
  - The "Test a message" box (`POST /terms/test`).
  - The words are shown, because moderators manage them, behind a "Show words" toggle that is off by default.
- **Blocked** (`#/blocked`): 1/7/30 days. Rows show time, person tag, room, term, and the blocked text. Actions are "Add
  exception" (opens the exception form, prefilled) and "View term".
- **Rule gaps** (`#/gaps`): open gaps with the note and ref code. An owner can close one as "Made it rule N" (an active-rule
  picker) or "Not a rule". Closed gaps list below.
- **Audit** (`#/audit`, senior and up): rows show time, actor, role, action label and target link. Filter by actor and
  action. Cursor "Load more".
- **Guide** (`#/guide`): the generated `documents.moderatorGuide` from `GET /policy?format=markdown`, rendered by the safe
  renderer, plus the ladder table rendered from `LADDER_TABLE`, plus the Community Rules list.
- Tests:
  - the term add with and without hits, the confirm, the refusal message, the toggle, the tester verdicts, and the "Show
    words" toggle
  - blocked days switching and the exception prefill
  - gap close per role, and an invalid rule → field error
  - audit paging and filters, and hidden for moderators
  - the safe renderer escapes `<script>`, `javascript:` links and raw HTML (no link renders unless it is `https:` or
    relative)
  - axe

### Task 7: `@chatwarden/player-react`
- Create `packages/player-react` with the package rules. Its components are presentational plus a small client over the
  player routes:
  - **`NoticeQueue`**: shows pending notices oldest first in an accessible dialog. A warning shows an Acknowledge button
    that calls `POST /notices/:id/ack`. The dialog shows the kind, the rule label, until, the excerpt lines with their day,
    the ref code, and an optional "Think this is a mistake?" link prop. A `canShow` prop holds notices during a game.
  - **`MyRecord`**: a list from `GET /record`, or an empty state.
  - **`RulesPage`**: the summary plus the numbered rules from `GET /rules`.
  - **`ReportDialog`**: transport-agnostic `onSubmit(input) → ReportResult`. It has a category picker and an optional
    note, and maps each `ReportRefusal` (`duplicate`, `rate`, `self`, `not_player`, `off`, `suspended`) to a plain message.
    It shows `remaining`.
  - **`RestrictedChatLine`**: `until`, `byModerator`, optional `refCode`.
- `createPlayerClient({ transport })` mirrors hub-react's transport (re-export the same type, without depending on hub-react).
- Tests:
  - each component's states
  - acknowledge removes the notice and moves focus correctly
  - the hold via `canShow`
  - each refusal message
  - the no-leak check
  - axe
  - size

Tasks 7b to 7e implement the addendum `docs/design/2026-11-10-hub-simple-mode-and-embedding.md`, which the owner approved on
2026-11-10. Read it first; its values are binding.

### Task 7b: Simple mode (the default)
- `HubProps.mode?: 'simple' | 'detailed'`.
  - When the prop is set, it fixes the mode and the switch is hidden.
  - When it is not set, the mode comes from the moderator's remembered choice (localStorage key `chatwarden.hub.mode`, every
    access in try/catch). The default is `simple`.
  - The top bar shows a Simple/Detailed switch (a two-option segment).
- **`CaseCard`, the Simple case view.** It holds exactly the addendum's content:
  - the name
  - the "Reported for" line
  - what they said: the person's lines only, the reported line marked, and "Show the whole chat (N more lines)"
  - a one-line record
  - the suggestion as a referee card, with its why line
  - the primary button named after the step, "No action needed", and "Something else…", which opens the full decision bar in
    place
  - the "what the player will see" line
- **One click and "No action needed" both go through the existing decision hold.** The 5-second Undo, release-on-leave, the claims
  and Decide-and-take-next are unchanged.
  - One click sends: verdict Fair, the suggested rule, reason = the rule's title, and evidence = the person's own lines (up to 5).
  - "No action needed" sends the Not-a-problem verdict with the reason "No rule was broken".
- **Shown only when it matters:**
  - The claim shows only when someone else holds the case.
  - A reporter warning shows when that reporter has at least 3 past reports and under a third of them were upheld.
- **The menu in Simple is Cases, Words, Blocked and More.**
  - More is a menu with Recent actions, Audit, Rule gaps and Guide, each still gated by `can`.
  - Every route and the command bar keep working.
- **Keys:** 1 is the primary button, 2 is "No action needed", and Ctrl/Cmd+Enter is the primary button plus take next. N, J and K
  are unchanged.
- **Tests:**
  - The mode precedence: prop, then stored choice, then the default. A throwing localStorage falls back to the default.
  - Every element the addendum says is hidden in Simple is absent.
  - The one-click body is exact.
  - Undo works in Simple.
  - The claim by someone else and Take over, gated.
  - The reporter-warning thresholds, with variants (2 reports; 3 reports with 1 upheld; 3 reports with 0 upheld).
  - The menu and More, per role.
  - The keys.
  - The audit-read counts match Detailed, or are fewer.
  - axe in both themes.
  - No overflow at 360px.
  - Detailed is unchanged: all existing tests stay green and run in `mode="detailed"` where they test the workbench.

### Task 7c: The headless controller (`@chatwarden/hub-react/headless`)
- **Move the stateful logic into plain TypeScript with no React import:**
  - the live queue and its change-token polling and backoff
  - case reads
  - the decision hold, Undo, send-now on pagehide or hidden, retry and restore
  - claims, the heartbeat and release-on-leave
  - toasts
  - the session cache
- `createHubController({ client, now? }): HubController` exposes stores with `subscribe(listener): () => void` and
  `getSnapshot()`. It also exposes these commands:
  - `takeNext`
  - `open(ref)` / `leave(ref)`
  - `decide(input, { hold })`
  - `undo(id)`
  - `release`
  - `takeOver`
  - `dispose()`
- **The React layer becomes thin hooks over the controller,** using `useSyncExternalStore`. Behaviour must not change: every
  existing hub-react test stays green without edits to its assertions.
- The package exports the `./headless` subpath (ESM and types).
- **Tests:**
  - The controller tested directly, with no DOM: the hold window edges, send-once across timer, pagehide and dispose, release on
    leave, the heartbeat, and the backoff while hidden.
  - A static test that `src/headless/**` imports nothing from `react`.
  - A bundle test that `@chatwarden/hub-react/headless` bundles without React.
  - A vanilla usage example in the README, tested as a doc snippet.

### Task 7d: Embeddable pieces, hooks and the API lock
- **`HubProvider`** takes the props `client`, `mode`, `t`, `locale`, `now`, `theme` and `shortcuts`. `<Hub>` becomes the
  provider plus the shell.
- **Standalone components** that need only the provider:
  - `CaseList`
  - `CaseCard`
  - `CaseWorkbench`
  - `PersonRecord`
  - `TermsManager`
  - `BlockedList`
  - `AuditLog`
  - `RuleGaps`
  - `Guide`
  - `RecentActions`

  Navigation is by callback props (`onOpenCase`, `onOpenPerson`, `onOpenReport`). Without a router or the shell, none of them
  navigate.
- **Headless hooks:** `useCases`, `useCase`, `useDecide`, `useClaim`, `useTerms`, `useBlocked`, `usePerson` and `useMe`, built on
  7c's controller.
- **The API lock:** a test snapshots the sorted export names of each entry point (hub-react, hub-react/headless, player-react).
  Exports are marked `@experimental` in TSDoc where the addendum says so.
- **README:** "Three ways to adopt", covering drop-in, pieces and headless, with tested snippets.
- **Tests:**
  - Each component mounts alone under the provider against the real routes.
  - The callbacks fire and nothing navigates.
  - Two pieces on one page share one controller (one change-token poller, one claim per case).
  - axe.
  - The JS size budget is re-measured, and the per-entry sizes are stated.

### Task 7e: `@chatwarden/hub-element` (any stack)
- **A new package** following the package pattern of hub-react and player-react. Its version and peers match.
- **What it ships:** a custom element `<chatwarden-hub>`, in one self-contained ES module that bundles React, react-dom and
  hub-react, with the CSS inlined into a shadow root.
- **Attributes:** `base-url`, `mode`, `theme`, `locale`, `game-name` and `shortcuts`. Changing an attribute re-renders.
- **Events:** `cw-navigate` with `{route, path}` and `cw-decided` with `{reportId, verdict}`, both bubbling and composed.
- **Theming:** the `--cw-*` custom properties set on the host pass through.
- **Registration:** the element registers once and is safe to import twice.
- **Tests:**
  - Mount and unmount (the controller is disposed and pending holds are sent).
  - Attribute changes.
  - Events.
  - Shadow DOM isolation: a page `button { color: red }` does not reach the hub.
  - The size budget: state it, with a reason.
  - A Playwright smoke run against a page that only has a script tag and the element.
- **README:** the one-script-tag quick start, including the npm CDN form.

Tasks 7f and 7g implement Part 1 of `docs/design/2026-11-10-editable-ladder-and-roadmap.md`, which the owner approved on
2026-11-10. Its values are binding.

### Task 7f: Editable profile in the kit (stored layer, routes)
- **Core.**
  - Add the profile fields `durations: number[]` and `customDuration: boolean` to every preset.
    - `durations` defaults to `[1h, 6h, 12h, 24h, 3d, 7d, 30d]` in milliseconds, and must be sorted, unique, and each value 1 or
      more and at most `MAX_DURATION_MS`.
    - `customDuration` defaults to `true`.
  - Validate both in `validateProfile`.
  - Ladder cells edited without a label get one generated, for example "Restrict chat 6 hours", "Ban from public rooms 12 hours",
    "Full ban 3 days" or "Full ban permanent".
- **The policy layer.**
  - `PolicyLayer` is a deep-partial of the editable sections: `durations`, `customDuration`, `ladder`, `firstOffense`, `repeat`,
    `areaRules`, `severeRules`, and `guidelines[i].outcome`.
  - A layer that touches any other field is refused.
- **The live profile.**
  - `cw.profile` becomes the effective profile (base, then code overrides, then the stored layer, validated) and is read live.
  - Every consumer reads it at call time: `suggest`, the decide checks, `documents.*`, and the AI brief. Audit each call site; a
    captured profile is a bug.
  - `cw.policy` gets these members:
    - `get()` returns `{effective, base, layer, version}`.
    - `save(layer, {version, actor, reason})` returns `{ok:true, version} | {ok:false, error:'conflict'|'invalid', path?}`.
    - `preview(layer)` returns the suggestions for the fixed sample records `clean`, `oneWarning`, `chat24h` and `ban7d`, each for
      the four conduct levels.
    - `reset(section?)`.
    - `refresh()`.
  - Another process's change is seen within 10 seconds, through a version check at most every 10 seconds on read.
- **Store.**
  - Add the optional methods `loadPolicyLayer(): {layer, version} | null` and `savePolicyLayer(layer, expectedVersion): number | null`.
    `null` means a version conflict, and the save is atomic.
  - Implement them in store-memory and store-sqlite. The SQLite store needs a migration: a new table, with an existing database
    upgrading cleanly.
  - Without these methods, `cw.policy.save` returns `{ok:false, error:'unsupported'}` and the rest works.
- **HTTP routes.**
  - `GET /policy/profile` needs `policy.read`.
  - `PUT /policy/profile` takes `{layer, version, reason}` and needs `policy.write`. It answers 409 `conflict` and 400 `invalid`
    with `path`. It writes audit `policy.update`, with the changed sections in the audit detail and the reason.
  - `POST /policy/profile/preview` needs `policy.read`.
  - `DELETE /policy/profile?section=` needs `policy.write` and is audited.
  - Add the new permission `policy.write` to the owner role only.
- **Tests (both stores where storage is involved):**
  - validation tables (good and bad durations, layers touching forbidden fields)
  - effective-profile merge order
  - every consumer seeing a saved change at once (a suggestion changes after save)
  - conflict on a stale version
  - reset per section and for everything
  - the 10-second cross-process refresh, with two `createChatwarden` instances on one store
  - the unsupported store
  - route permissions and audit rows
  - a SQLite migration from an existing database
  - generated labels
  - the README and docs for the new API

### Task 7g: Steps and ladder in the hub, durations in pickers, quick warning
- **The settings screen.**
  - Route `#/settings/ladder`. It is under More in Simple, and under a Settings nav item in Detailed.
  - It is gated by `policy.read`. Editing needs `policy.write`; any other role sees the screen read-only.
  - Sections, matching the addendum:
    - durations, as chips plus the custom switch
    - the ladder grid
    - first offence
    - repeated
    - the area and severe rule pickers
    - the guidelines' outcome text
  - A live preview panel calls `POST /policy/profile/preview`, debounced.
  - Saving requires a reason. A 409 shows "Someone else changed these settings" with a Reload button. A 400 focuses the field at
    `path`.
  - Each section has a reset, and there is a reset for everything. Both use an in-page confirm.
  - With an unsupported store, the screen is read-only with one plain sentence saying why.
  - The section is also exported as a piece, `LadderSettings`, plus the hook `usePolicy`. Both are `@experimental` and added to the
    API lock.
- **Pickers.**
  - The decision bar and the sanction form offer the profile's `durations`, "Custom length" (hours or days) when `customDuration`
    is on, and permanent when allowed.
  - The bounds and validation match the kit.
- **The Simple card's quick warning.**
  - When the suggestion is harsher than a warning, add "Send a warning". It uses the same hold and Undo, with the reason set to the
    rule title.
  - Key 3 sends the warning in Simple only when "Something else…" is closed.
- **Tests:**
  - each section's edit, then preview, then save, then the suggestion change, against the real routes
  - conflict, invalid path focus, resets, and the read-only role
  - the unsupported store
  - custom length bounds
  - the quick warning: its body, Undo, and key 3
  - axe in both themes
  - layout at 360 px (the grid scrolls inside its own container)
  - the API snapshot updated

Tasks 7h and 7i implement Part 1b of `docs/design/2026-11-10-editable-ladder-and-roadmap.md`, which the owner approved on
2026-11-10.

### Task 7h: Reporting settings in the kit
- **Policy layer.** Extend it (Task 7f) with a `reporting` section:
  - `flow`: `'one_tap' | 'reason_first' | 'reason_required'`, default `one_tap`.
  - `reasons`: an ordered list of `{ id, label, hint, group, rules: number[], asksNote: boolean, enabled: boolean }`.
  - `thanks`: a string, default "Thanks for the report. We'll look into it."
- **Default reasons:**
  - Chat: `harassment` (Insults or harassment), `hate` (Hate), `sexual` (Sexual content), `threat` (Threats), `spam` (Spam or ads),
    `personal_info` (Sharing personal info).
  - Gameplay: `cheating` (Cheating), `griefing` (Throwing or griefing), `afk` (Leaving or AFK).
  - Then `other` (Something else).
  - Each reason maps to the matching starter Community Rules.
  - The old ids keep working: `disruption` maps to `griefing`.
- **Validation:** ids are unique slugs, there are 1 to 20 reasons, and at least one is enabled. `other` cannot be removed, only
  relabelled.
- **Reports:**
  - `ReportInput.reason?: string | null` replaces the required `category`. `category` stays accepted as an alias.
  - With `flow: 'reason_required'`, a missing reason is refused with a new `ReportRefusal`, `reason_required`.
  - An unknown or disabled reason is refused with `reason_unknown`.
  - The stored report has `reportedReason: string | null`.
  - `cw.reports.addDetail(reportId, reporterSeat, { reason?, note? })` adds the optional follow-up. It works once, only for the
    reporter, and only within 10 minutes.
- **Staff views and routes:**
  - `ReportSummary` and the details carry `reportedReason` and its label.
  - `GET /reports` filters by `reason`, including `none`.
  - The reporter record gains `reasonMatched` and `reasonDecided` counts. A reason "matched" when the decided rule is in its
    `rules`.
  - `GET /policy/profile` and `PUT /policy/profile` include `reporting`.
  - The player route `GET /rules` returns the enabled reasons (id, label, hint, group, asksNote), the flow and the thank-you, so the
    player UI can render them.
- **Tests:**
  - validation tables
  - each flow
  - every refusal
  - legacy category aliases
  - the follow-up's window and ownership
  - reporter accuracy counts
  - filters
  - the player `/rules` payload, with no leak
  - both stores
  - a SQLite migration for `reportedReason`

### Task 7i: Reporting in player-react and the hub
- **player-react `ReportDialog`:**
  - It renders the flow from `/rules` data, or from props.
  - `one_tap`: a single "Report" button sends at once and shows the thank-you, with an optional "Add a reason" step that calls the
    follow-up.
  - `reason_first` and `reason_required`: grouped reasons (radio groups per group, keyboard-friendly), with the note shown when
    `asksNote`.
  - Map the new refusals to plain messages. Keep the transport-agnostic `onSubmit`, plus an `onAddDetail`.
- **Hub:**
  - Settings gains a "Reporting" section for the flow, the reasons (add, edit, reorder, enable, rule mapping, asks a note) and the
    thank-you copy.
  - Case views show "Reported as X" or "No reason given".
  - The Simple card for a report with no reason asks "Which rule does this break?" with a rule picker. The suggestion and one-click
    button appear once a rule is picked.
  - The reporter record shows reason accuracy.
  - Add the `reason` filter in the queue (Detailed).
- **Tests:**
  - each flow end to end against the real routes
  - the follow-up
  - settings edits, then the dialog changing
  - the no-reason Simple card
  - axe
  - 320 and 360 px
  - the API snapshot updated

### Task 7j: hub-react is shadow-DOM safe and themable from any ancestor (then drop hub-element's workarounds)
Task 7e found that hub-react reads `document` directly. Its uses are `document.addEventListener('keydown')` in the shell, and
`document.activeElement`, `document.getElementById` and `document.querySelector` in Dialog, DecisionBar, CaseCard, SimpleNav and
others. It also declares its `--cw-*` tokens on `.cw-hub`, which blocks inheritance from ancestors. hub-element works around both at
build time. Fix them at the source.
- **Find nodes through the hub's own root.** Every lookup goes through a `rootOf(el)` helper, `el.getRootNode()`, which is a
  `Document` or a `ShadowRoot`. Focus checks use that root's `activeElement`.
- **Keyboard shortcuts.**
  - Listen on the shell element, through the 7d `KeyScope`, never on `document`.
  - The "typing?" check uses `event.composedPath()[0]`.
  - The command bar and the shortcut sheet keep working.
- **A static test** forbids `document.` in `packages/hub-react/src`, except in a small allow-list file (the root helper and the
  page-hide source).
- **Theming tokens.**
  - Every `--cw-*` token is read as `var(--cw-x, <default>)`.
  - The defaults live in private `--cwd-*` names on `.cw-hub`.
  - A value set on any ancestor wins, so `<Hub>` can be themed from `body` too.
  - Light-dark behaviour is unchanged.
  - A CSS test checks that no rule declares a public `--cw-*` name on `.cw-hub`.
- **hub-element cleanup.** Delete the build-time `document` shim and the CSS token transform. Its tests, including the Chromium
  smoke, must stay green unchanged.
- **Tests:**
  - shadow-root mounts of `<Hub>` and of pieces in jsdom: keys, dialogs, focus return, J/K and the command bar
  - two hubs on one page, with keys scoped to the focused one
  - themed from an ancestor in both themes
  - the static test and the CSS test
  - axe

### Task 8: The site demo uses the real hub and player UI
- In `site/`:
  - Replace `src/demo/ModPane.tsx` with `<Hub client={hubClient(routerTransport(createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }), terms }))))} router={memoryRouter} />`
    inside the demo's right pane.
  - Replace the hand-built notice and report dialog in the game pane with player-react's `NoticeQueue` and `ReportDialog`.
    The player routes don't run in a browser, so the player client in the demo calls `cw.notices.*` through a small local
    transport.
  - Keep the guided tour working: its steps now point at hub controls via stable `data-tour` hooks that hub-react exposes
    as a documented `tourHooks` option, or at accessible names.
  - Remove `tag: 'Hub UI is coming'` and rewrite the hub card's body to say what ships, with an npm link.
  - Add hub-react and player-react to "Add it in 3 steps" (the mount-the-hub step, from the hub README's verbatim lines),
    `llms.txt`, and the "Built in the open" npm links.
- Keep every existing site test green, and update the ones whose subject changed (the ModPane tests move to the hub).
  - The demo chunk budget is re-measured and stated.
  - The CSP browser test proves the hub's CSS loads with no violation.
  - axe passes at 360, 768 and 1440 in both themes.
- Update the root README's package table and the design doc's phase status for K4 to "done".

### Task 9: Mount the hub in the example app, docs, release prep
- `examples/tiny-chat` serves the hub at `/mod` (a small Vite build of a page that mounts `<Hub client={hubClient(fetchTransport({ baseUrl: '/api/mod' }))} />`) behind its existing staff `authorize`. The example's integration test loads `/mod`
  and the staff API from the same process.
- READMEs for both packages:
  - install
  - mount (Express and any other server: "serve the built page and the staff API under one origin")
  - auth: the hub sends cookies or a header via `fetchTransport({ headers })`, and the server's `authorize` decides
  - theming variables
  - `t` and the `locale` prop
  - CSP notes
  - the full component and prop reference
- RELEASING.md: new packages must be published once with the token (npm's trusted publishing can only be configured on an
  existing package), then get a Trusted Publisher like the others.
- Add the changeset (minor for the fixed group) with plain notes.
- Run the targeted tests of every touched package plus the smoke script (`node scripts/smoke.mjs` or the CI equivalent,
  extended to install and import both new packages in the ESM and CJS consumer projects).
