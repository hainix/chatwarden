---
status: approved
updated: 2026-11-10
---

# Simple mode and embedding the hub (addendum to the 2026-11-10 workbench design)

On 2026-11-10 the owner looked at the case pane and said: "the ui is PRETTY DENSE. maybe there should be an advanced/simple toggle
that hides a lot of the details and allows just the barebones tasks to be done / handled, supporting a simple 1-2 person team and
small shop just adding chat moderation or building it into their own ops dashboard". The mockup is the artifact "Hub Simple Mode".

The owner's answers:

- **Simple is the default** for a new install. Detailed is today's workbench.
- **The main button applies the suggestion in one click.**
- **The menu is Cases, Words, Blocked, plus More.**
- **Embedding:** "build everything for them with maximum compatibility and flexibility and feature set for future proofing, but we want
  adoption to be chill".

## Simple mode

- **Switching.** A Simple/Detailed switch sits in the top bar. Each moderator's choice is remembered in the browser; when storage is
  unavailable, the hub falls back to the default. An adopter can fix the mode with `<Hub mode="simple" | "detailed">`, which hides
  the switch. The default is `simple`.
- **The case card**, which in Simple replaces the three panes:
  - the person's name
  - "Reported for <category> by <reporter>, <when>". Several reports read "3 reports: hate, harassment".
  - **What they said:** only the reported person's lines, with the reported line marked. "Show the whole chat (N more lines)"
    reveals the rest.
  - **Their record:** one line ("Nothing in the last 90 days", or "2 past steps: a warning, a 24-hour chat restriction").
  - **The decision.** The ladder suggestion is a referee card with one sentence of why, then three controls:
    - a primary button named after the step ("Restrict chat, 24 hours")
    - "No action needed"
    - "Something else…", which opens the full decision bar in place
- **One click** sends the suggestion with these defaults:
  - verdict Fair
  - the suggested rule
  - the reason set to the rule's title (the kit requires a reason)
  - the person's own lines as the evidence, up to the existing cap of 5
  - the same five-second Undo, held client-side exactly as in Detailed

  A line under the buttons says what the player will see ("HexHound sees these 2 lines and Rule 4. You can undo for 5 seconds.").
- **Hidden until it matters:**
  - Claims are still taken and released silently, so two people never decide the same person. The claim shows only when someone
    else holds the case (read-only, with "Maya is on it"), and Take over appears for those allowed.
  - The reporter's record appears only as a warning when most of their past reports were not upheld (at least 3 reports, under a
    third upheld).
  - Person tags, the room, status chips, tabs, the people pane, transcript filters and line checkboxes, the rule picker, Add an
    action and saved-reason chips. All of these are in "Something else…" or in Detailed.
- **"No action needed"** sends the Not-a-problem verdict, with the reason "No rule was broken", and the same Undo.
- **Bad faith** and every other step are under "Something else…".
- **The menu.**
  - Cases is the queue and the case card. It replaces Overview and Reports in the main menu.
  - Words is Terms.
  - Blocked is Blocked.
  - More holds Recent actions, Audit, Rule gaps and Guide.
  - The command bar (Ctrl+K) and every route still work in Simple.
- **Keys:** N, J/K, 1 (the primary button), 2 (No action needed) and Ctrl+Enter (the primary button and take next) work in Simple.

## Embedding: four layers, adopt at any depth

Adoption stays easy: the first layer is a few lines, and each later layer is optional and builds on the one above it.

1. **Drop-in.**
   - React: `<Hub client={createHubClient(fetchTransport({ baseUrl: '/admin' }))} />`, Simple by default.
   - Any other stack, including a plain HTML ops page: `@chatwarden/hub-element`. It is a custom element `<chatwarden-hub>` in one
     self-contained ES module (React bundled in), so it also loads from an npm CDN with one script tag.
     - It renders in a shadow root, so neither page's CSS leaks into the other. Theming goes through the same `--cw-*` custom
       properties, which pass through the shadow boundary.
     - Attributes: `base-url`, `mode`, `theme`, `locale`, `game-name`, `shortcuts`.
     - DOM events: `cw-navigate` (the route) and `cw-decided` (a report id and its verdict).
2. **Pieces (React).**
   - `<HubProvider client mode t locale now>`, plus standalone components that need only the provider, with no shell, no nav and no
     router:
     - `CaseList` and `CaseCard`, the Simple card
     - `CaseWorkbench`, the Detailed case
     - `PersonRecord`, `TermsManager`, `BlockedList`, `AuditLog`, `RuleGaps`, `Guide` and `RecentActions`
   - Navigation is a callback (`onOpenCase(ref)`, `onOpenPerson(ref)`), so the adopter's own router decides where things go.
3. **Headless hooks (React):** `useCases`, `useCase`, `useDecide`, `useClaim`, `useTerms`, `useBlocked`, `usePerson` and `useMe`. They
   carry the same Undo hold, claims, heartbeat and live updates as the hub, with no markup.
4. **Headless controller (any framework):** `@chatwarden/hub-react/headless` exports `createHubController({ client, now })`.
   - It is plain TypeScript with no React import, and its stores follow the `subscribe/getSnapshot` contract.
   - The stores are the queue with live updates, a case, decisions (hold, undo and send now, including on page hide), claims
     (take, heartbeat, release) and toasts.
   - Vue, Svelte, Solid or vanilla code use it directly. The React hooks are built on it, so there is one implementation of the
     behaviour.

Below all four, the HTTP routes and `createHubClient` remain the contract for anyone who wants none of the UI.

## Future proofing

- **The public API is locked by a test:** a snapshot of every export name, per entry point, for hub-react, its `/headless` subpath,
  player-react and hub-element. Changing it is a deliberate snapshot update, and the changeset says which way.
- **No layer reaches into another's internals:** the components use the hooks, and the hooks use the controller.
- **Unstable pieces** are marked `@experimental` in TSDoc and listed in the README until 0.2.
- **The i18n catalogs stay one flat key map,** so a new key never breaks an adopter's partial catalog.

## Not in this phase

- Routed queues, per-team queues and SLA rules (as decided on 2026-11-10: filters, not routing).
- Wrappers for other frameworks (a Vue or Svelte component). The headless controller is the seam for those, and they can follow
  when an adopter asks.
