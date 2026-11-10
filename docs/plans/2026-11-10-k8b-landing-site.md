# K8b: chatwarden.dev landing page with the live demo (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers MUST load the `frontend-design:frontend-design` skill before any UI work.

**Goal:** A fun, polished, game-flavoured landing page for chatwarden.dev. The centrepiece is an interactive demo in
which the visitor plays in a game chat, gets refused for a synthetic slur, reports a line, moderates it in a
moderator panel, and sees the player's notice. The demo runs the REAL kit in the browser. Around it, the page says
what Chatwarden does, how little code it takes, and that it's free.

**Architecture:**
- A static site in `site/` (Vite + React + TypeScript), added as an npm workspace with `"private": true` so it is
  never published.
- The demo imports `@chatwarden/core`, `@chatwarden/matcher` (with the fixtures pack) and `@chatwarden/store-memory`
  from the workspace. These are browser-ready after K8a.
- Until K8a merges, Tasks 1-2 build the page and the demo UI against a thin `DemoEngine` interface. Task 3 then binds
  that interface to the real kit.
- Deploy target: Cloudflare Pages with the custom domain chatwarden.dev (the owner bought it on Cloudflare). This plan
  produces a deploy-ready `site/dist` and a `wrangler pages deploy` script. The first deploy is the controller's or the
  owner's step, after review.

**Tech Stack:** Vite, React 18, TypeScript, CSS (custom properties, no UI kit), Playwright for screenshot checks
(already available as an MCP tool to the controller), and vitest for the demo logic.

**Spec:** docs/design/2026-11-09-chatwarden-design.md (K8), docs/design/2026-11-09-product-scope.md, and the owner's
direction on 2026-11-10: "a fun, polished gamer landing page".

## Global Constraints

- **Its own visual identity, game-flavoured and fun, and NOT Moxgate's look.** It should feel like a modern game
  studio's site:
  - bold display type
  - a dark theme by default, with a light theme
  - one confident accent colour plus a "warden" signature colour
  - pixel or HUD details used sparingly
  - motion that delights but respects `prefers-reduced-motion`

  It must stay credible to engineers, so no fake stats, no stock-photo filler and no lorem.
- **Honest copy only.** No invented customers or numbers. "Used by Moxgate" is true. The no-SLA line stays. The AI
  levels show as "coming" where they aren't shipped: K3c is not built yet.
- **Synthetic demo terms only** (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn). Never a real slur,
  anywhere in the site source or the build.
- **Performance:** no third-party scripts, analytics, trackers or web fonts from third-party CDNs. Self-host any font
  and subset it. The demo chunk is code-split and lazy-loaded below the fold or on interaction. Lighthouse
  performance and accessibility should both be ≥ 90 on mobile.
- **Accessibility:**
  - semantic landmarks and keyboard-operable demo
  - visible focus
  - contrast AA
  - the demo announces refusals and notices through an `aria-live` region
  - works at 360px width with the panes stacked
- Site copy is plain and short, written for indie game developers and their coding agents.
- Targeted tests only. The site has its own `npm run test --workspace site`. Never run the full repo suite.

## Review Focus

1. **The real kit, not a mock.** After Task 3, the demo's verdicts come from `@chatwarden/*` code paths, and a test
   proves the refusal comes from the matcher.
2. **Phone layout.** At 360px wide, nothing overflows, the demo panes stack, and the guided tour stays usable.
3. **Keyboard.** Keyboard-only users can complete the four-step tour.
4. **Reset.** "Reset demo" returns to a clean state, and a reload never shows stale state.
5. **Page weight.** Initial JS stays under about 120 KB gzip before the demo chunk loads.

---

### Task 1: Site scaffold, visual identity, static sections
- Add the `site/` workspace: Vite + React + TS, ESLint coverage, and build output in `site/dist`.
- Load the frontend-design skill and commit to a visual direction. Write it down in `site/DESIGN.md`: palette tokens,
  type scale, motion rules and the logo mark (an SVG wordmark plus a small shield or warden glyph).
- Sections:
  1. **Hero:** a one-line pitch, sub-line, "Try the demo" and `npm i @chatwarden/core`, with a copy button. Use an
     animated chat snippet, not an image.
  2. **Demo** (placeholder slot, filled in Task 2).
  3. **What you get:** six cards (catch slurs that dodge filters, reports with evidence, a fair ladder, player
     notices, moderator hub and roles, Discord and webhooks), each with an icon.
  4. **Add it in 3 steps:** real code from the READMEs, copyable, syntax-highlighted with a tiny local highlighter
     (no CDN).
  5. **AI moderation levels 0-4:** levels 0-1 available, 2+ coming, with the hard ceilings stated.
  6. **Works with:** Express, any Node game server, Discord, and webhooks.
  7. **Built in the open:** Apache-2.0, provenance badge, GitHub link, npm link, "used by Moxgate".
  8. **FAQ:** privacy, no SLA, the community term list.
  9. **Footer.**
- Add a theme toggle (dark default, respecting `prefers-color-scheme` on first visit).
- Tests:
  - vitest render tests for each section
  - a copy button test
  - a scan of the built `dist` for any term outside the synthetic list (reuse the matcher test's allow-list idea) and
    for third-party URLs

### Task 2: Demo UI (against a `DemoEngine` interface)
- Split view:
  - **left "The game":** a chat room with three seats. The visitor is one seat, and two scripted players chat on a
    timer the visitor can pause.
  - **right "Your moderator":** a queue, report detail (evidence lines, category, ladder suggestion), decide buttons
    (Warn / Timeout 10m / Note / No action), choosing which line to show the player, the player-notice preview, and
    "My record".
- Add a guided tour with four steps (say something bad, report it, decide, see the player's view), progress pips and
  a Skip option. The tour and the demo must be fully usable without it.
- Add a "Show me the code" toggle per step that reveals the few lines of real kit code behind that step, taken from
  the READMEs.
- Add a Reset button.
- `DemoEngine` is an interface (`say`, `report`, `queue`, `decide`, `notices`, `ack`, `reset`). Task 2 ships a small
  in-memory fake behind it, clearly named `FakeEngine` and used only until Task 3.
- Tests: the tour flow, keyboard path, aria-live announcements, reset, and the stacked layout class at narrow widths.

### Task 3: Bind the demo to the real kit (after K8a merges)
- `KitEngine implements DemoEngine`:
  - `createChatwarden` with `@chatwarden/store-memory`
  - the matcher with `@chatwarden/matcher/fixtures` (synthetic pack, plus its positive corpus)
  - three seats with fixed demo identities
  - `reports.submit`, `decide`, and the player notices
- Delete `FakeEngine`.
- Lazy-load the engine chunk.
- Tests:
  - a refusal of `zorbak` comes from the matcher (spy or a term id)
  - a decided warning yields a notice with the chosen excerpt
  - reset gives a clean engine
  - the bundle contains no `node:` specifier

### Task 4: Polish, performance, accessibility, deploy readiness
- Playwright screenshots at 360, 768 and 1440 widths, in both themes.
- Fix every visual issue found.
- Performance:
  - self-hosted subset font
  - image-free hero
  - meta and OG tags plus an OG image rendered from an SVG at build time
  - favicon set
  - `robots.txt`, `sitemap.xml`
  - `llms.txt` pointing coding agents at the READMEs
- Add a `site/README.md` covering local dev, build, and deploy (`npx wrangler pages deploy site/dist --project-name chatwarden`), plus the custom-domain steps for chatwarden.dev.
- Add a CI job that builds the site and runs its tests.
