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

**Spec:** docs/design/2026-11-09-chatwarden-design.md (packages table, "Two review backends", AI provenance rules, K4,
K8 demo), docs/design/2026-11-09-feature-contract-from-moxgate.md (the hub's screens and player notices), and the owner's
direction on 2026-11-10: "it says 'hub ui is coming' from the website, do any remaining work to have this be fully
feature complete".

## Global Constraints

- Both packages are **published** and join the changesets `fixed` group. Versioning: one **minor** changeset for the group
  (0.1.1 → 0.2.0), since there are new packages and new routes. Each new package gets README, LICENSE, `files`, `exports`
  with types, `sideEffects` listing only its CSS, `prepack: tsc -b`, a VERSION constant synced by `scripts/sync-version.mjs`,
  and an entry in `scripts/publish-order.mjs` and `scripts/check-pack.mjs` (both browser-safe).
- `react` and `react-dom` are **peerDependencies** only; never bundle React. `@chatwarden/core` and `@chatwarden/http` are
  peer `^0.2.0` for hub-react, and core for player-react. Use type-only imports where possible.
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

### Task 5: Person page, direct sanctions, notes and revoke
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
- `playerClient({ transport })` mirrors hub-react's transport (re-export the same type, without depending on hub-react).
- Tests:
  - each component's states
  - acknowledge removes the notice and moves focus correctly
  - the hold via `canShow`
  - each refusal message
  - the no-leak check
  - axe
  - size

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
