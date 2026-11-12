# Chatwarden: Claude Code reference

Chatwarden is an open-source chat-moderation kit for games (Apache-2.0, npm scope `@chatwarden`, site chatwarden.dev).

**[AGENTS.md](AGENTS.md) holds the rules every agent and contributor follows** (licence, Node, ESM, privacy rules, exact values,
test-first, targeted test runs). This file is the Claude-specific layer: where things are, how work is run, and where to look
before changing an area.

## Start here
- [docs/status.md](docs/status.md): what each phase has shipped, what is next, open follow-ups.
- `docs/design/`: the design notes, one per decision area, dated. They are the authority; plans argue from them.
- `docs/plans/`: one implementation plan per phase; `docs/plans/follow-ups.md` for parked items.
- Maintainers keep private notes (release credentials state, owner preferences, session history) outside the repo, in Claude
  Code's per-project memory. If a `CLAUDE.local.md` exists beside this file, read it.

## Packages
| Package | What it is |
| --- | --- |
| `core` | The engine: chat path, matcher hook, sanctions, ladder, reports, notices, policy, documents. No runtime deps. |
| `store-memory`, `store-sqlite` | Storage. Both pass the shared contract suite in `test/contract/`. |
| `matcher`, `profanity` | Term matching and the profanity filter. |
| `http` | Staff (`/admin`, browser-safe subpath `@chatwarden/http/admin`) and player routes, webhooks, and the chat: a room broadcaster and four routes (browser-safe subpath `@chatwarden/http/chat`). |
| `discord` | Discord forum feed. |
| `hub-react` | The moderator hub. Simple and Detailed views; `<Hub>`, pieces under `HubProvider`, hooks, and a framework-agnostic controller at `/headless`. |
| `player-react` | Player UI: notices, my record, rules page, report dialog, restricted-chat line, and `<ChatBox>` at the lazy subpath `@chatwarden/player-react/chat` (its words are `enChat`, apart from `en`, to keep the main entry's size). |
| `hub-element` | `<chatwarden-hub>`: the whole hub in one script tag (bundles React; ships THIRD_PARTY_NOTICES.txt). |

`site/` is chatwarden.dev (Vite + React, live demo on the real kit and hub). `examples/tiny-chat` is the runnable example.

## Working rules
- **Never run a full test suite locally.** Run test files by path (`npx vitest run packages/<pkg>/test/<file>`); a package once
  at the end of a task (`npx vitest run packages/<pkg>`) is the package gate. The site is its own project:
  `npm test --workspace @chatwarden/site`. CI runs everything.
- **Test-first**: the failing test, seen red, then the change. Cover variants and edge cases.
- **Synthetic terms only** in code, tests and docs: zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn.
- **Commits**: `git commit -s` (DCO). With more than one agent in a worktree, commit by pathspec and `git add` new files first.
- **Merges**: gate on green CI: `if gh pr checks <n> --watch --fail-fast; then gh pr merge <n> ...; fi`.
- **Publishing and site deploys** are outward and permanent: only on the maintainer's go-ahead. Steps: [RELEASING.md](RELEASING.md)
  and [site/README.md](site/README.md).
- **Browser tests** (Playwright) must skip when Chromium is missing and fail only under `CW_REQUIRE_BROWSER=1`; the package CI
  jobs have no browser.
- **UI work**: colour only where it means something (blue = you / next action, red = overdue / reported / ban, yellow =
  warning); referee cards for sanctions; blocked words masked until revealed; every string through `t()`; check the result in a
  real browser at desktop and 360 px, light and dark.

## Before you change an area
| Area | Read first |
| --- | --- |
| Ladder, profiles, standards | `docs/design/2026-11-09-moderation-standards.md`, `docs/design/2026-11-10-editable-ladder-and-roadmap.md` |
| Reporting flow and reasons | `docs/design/2026-11-10-editable-ladder-and-roadmap.md` (Part 1b) |
| Hub UX, teams, claims | `docs/design/2026-11-10-hub-workbench-and-teams.md` |
| Simple mode, embedding, public API | `docs/design/2026-11-10-hub-simple-mode-and-embedding.md`; the API lock in `packages/hub-react/test/api.test.ts` |
| Product scope and phase order | `docs/design/2026-11-09-product-scope.md` |
| Releases, versions, peers | `RELEASING.md` |
| Site deploy and CSP | `site/README.md` |

## Process
Phases follow brainstorm, then a design note, then a plan, then subagent-driven development: one implementer per task, a review
per task, a whole-branch review at the end. Work happens in git worktrees next to the main checkout. Per-plan ledgers and review
files go in the git-ignored `.superpowers/sdd/<plan>/` of the worktree.
