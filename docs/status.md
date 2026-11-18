# Status

Updated 2026-11-18. The full roadmap and the reasoning behind it: [design/2026-11-09-product-scope.md](design/2026-11-09-product-scope.md).

## 0.2.0: published (2026-11-18, all ten packages on npm, tag `v0.2.0`, PR #40)

Published from tag `v0.2.0` through npm trusted publishing with provenance; chatwarden.dev is redeployed. Every `@chatwarden/*` peer is `^0.2.0`, and each package's `CHANGELOG.md` has a "Breaking changes for adopters" section: read it first. CI ran the full suite on Linux (Node 22.13 and 24), the Windows CLI job, the consumer-install smoke, the hub-element Chromium smoke, the site build and the C# sample against a live service.

- **What 0.2.0 is.** Text chat only. An urgent lane and welfare reports, a second look and Insights, rooms under attack (lock, emergency, retract, probation), chat filters, privacy requests and legal hold, contexts and staff scope, blocks and phrase-only chat, reserved names and entity reports, terms without spaces, service mode (`@chatwarden/http/service`, `chatwarden serve`), shared pacing, and machine-drafted Spanish and Portuguese. Each is described in its own section below.
- **No backward compatibility.** There are no users on 0.1.x yet, so nothing is kept compatible: the store contract, `Session`, `HubClient`, `PlayerReporting`, the chat wire (version 2), `GET /me`, the staff cookie (Secure by default) and SQLite migration 26 (one-way) all change. The list is in the changelog.
- **`@experimental` is settled.** The tag is gone from every public name added through 0.1.x and 0.2.0, except the Coop and EOS adapters, the Discord bot and the feed's button `components`, which were written from the services' documents and have not run against the live services. `scripts/experimental-settled.test.ts` holds that list.
- **Size budgets.** The measured numbers are in each package's size test. The standalone `hub-element` script is 1,447 KB minified and 377 KB gzipped (budget 400 KB), because it inlines every lazy chunk and both catalogues; the module for a bundler keeps them lazy.
- **Still the owner's, new in this release.** A native-speaker read of the Spanish and Portuguese words; a real-browser pass at desktop and 360 px, light and dark, for the new hub screens (see [plans/follow-ups.md](plans/follow-ups.md)); the live checks of the Discord bot, Coop and EOS; and Moxgate onto 0.2.0 (in progress).

### Privacy requests and legal hold

In 0.2.0: an owner can export and erase one person's data (a receipt, a stated safety remainder, a dry run, a finish that runs by itself), and a senior can hold one report so no purge and no erase reaches it, with a signed evidence bundle and a `report.escalated` event. The tools are `cw.privacy` and `cw.legal`, the owner's staff routes, and "Data requests", "Privacy requests" and "Legal hold" in the hub. The runbook is [privacy-requests.md](privacy-requests.md). It describes what the kit stores and does; it is not legal advice and makes no claim that any law is met, and the kit never contacts a requester, a player or an authority. Parked: see [plans/follow-ups.md](plans/follow-ups.md).

**Spanish and Portuguese (0.2.0, machine-drafted).** The player components (235 keys) and the moderator hub (1,955 hub keys, 202 for the AI parts, 104 for the privacy parts) have Spanish and Brazilian Portuguese catalogues, as lazy subpath modules (`@chatwarden/player-react/locales/es` and `/pt`, `@chatwarden/hub-react/locales/es` and `/pt`) with `matchLocale` and a loader in each package; the hub loads one when `locale` asks for it and no `t` is given. They are written by an AI model and no person has read them: `meta.status` is `machine-draft`, a test pins it, and the guide ([recipes/translations.md](recipes/translations.md)) lists the notice, refusal, appeal and sanction words a native-level reader should check first. English is the safe choice until then. The default report reasons and thank-you follow the player's language only while the server's text is still the English default. The standalone `hub-element` script inlines both hub catalogues (+74 KB gzipped); its budget was raised to 400 KB.

## Published state
All ten packages are on npm at 0.1.14 (0.2.0 is built on the branch and not yet published; see above) (core, matcher, store-sqlite, store-memory, http, profanity, discord, hub-react, player-react, hub-element), published from tags v0.1.6 to v0.1.14 on 2026-11-17. That is the chat box (0.1.6), AI levels 1 and 2 (0.1.7), slow mode, flood control and signals (0.1.8), appeals and offensive names (0.1.9), the setup command, recipes and test kit (0.1.10), the shared community term list loader (0.1.11), the Discord bot, Coop and EOS integrations (0.1.12), and the AI gate dashboard and shadow mode (0.1.13 and 0.1.14). The AI still never acts: nothing in 0.1.14 writes a sanction, a notice or a decision. The site copy and `llms.txt` describe this state, and carry no timing claim: the timing record does not exist.

**Still the owner's** (none of these is a task for the code):
- **AI acting (R3) gate.** R3 does not start until shadow has run at least 14 days in a real game, the owner has read the "would have acted" list, and appeals are in use. See [plans/follow-ups.md](plans/follow-ups.md).
- **Watch (R4).** Level 4 only files reports for a person to decide; it needs R3 to have run first. Designed, not built.
- **The K7 service deploy.** `services/corpus` is built and tested with no Cloudflare account; nothing is deployed, and no list release is published.
- **The live checks:** the Discord bot (D10), Coop (C8) and the EOS sandbox (E5). Every test so far uses a fake. The steps are in [plans/follow-ups.md](plans/follow-ups.md).
- **`eval:ai`.** The opt-in agent eval (`npm run eval:ai --workspace @chatwarden/example-ai-anthropic`) calls the real API with the maintainer's key, and is never run in CI.
- **The legal read** of the community term list's privacy page and consent wording (`docs/design/2026-11-12-k7-term-corpus.md`, section 15).
- **The Moxgate engine switch:** moving Moxgate's own engine onto the kit (K6b to K6d).
- **The unscoped `chatwarden` npm name.** The command ships as the bin of `@chatwarden/http`; an unscoped package for `npm create` is a separate change if the owner wants it ([design/2026-11-12-k4b-adoption.md](design/2026-11-12-k4b-adoption.md), section 4).

## Shipped
| Phase | What | Where |
| --- | --- | --- |
| K0+K1 | Foundation: hasher, stores, subjects, evidence, matcher, live terms, sanctions, mutes, strikes, chat, reports, doors, retention, facade, tiny-chat | PR #1 |
| K2 | Community Rules, warnings, the ladder, player notices | PR #2 |
| K3a | Moderation standards (conduct levels, profiles relaxed/standard/strict), guidelines, generated documents, profanity package | PR #3 |
| K3b | HTTP staff and player routes, roles and permissions, audit, signed webhooks, Discord feed | PR #4 |
| KR | Release readiness; 0.1.0 published | PR #5 |
| K8a | Browser-ready core, store-memory; 0.1.1 published | PR #7 |
| K8b | chatwarden.dev landing site with a live demo | PR #9, #11 |
| K4 | Moderator hub (`hub-react`: team workbench, Simple mode, settings, four ways to adopt), `player-react`, `hub-element`; editable steps and ladder; configurable one-tap reporting; site demo on the real hub. Releases as 0.1.2 | PR #12 |
| Triage speed | One-click "Nothing wrong here" with no typed reason, auto-advance with Undo after the move, bulk dismiss, reporter accuracy and the habitual-reporter ranking, keyboard queue mode. Releases as 0.1.5 | PR #20 (plan: [plans/2026-11-11-triage-speed.md](plans/2026-11-11-triage-speed.md)) |

## Chat box (0.1.6; merged, PR #23; published)
A game with no chat adds moderated chat in minutes: `@chatwarden/http` gains a room broadcaster and four routes (Server-Sent Events down, `POST`
up; `@chatwarden/http/chat`), `@chatwarden/player-react` gains `<ChatBox>` and `sseTransport` at the lazy subpath `@chatwarden/player-react/chat`
(its own words, `enChat`, and `chat.css`), and `examples/tiny-chat` has a browser page that uses them. Design:
[design/2026-11-12-chat-box.md](design/2026-11-12-chat-box.md); plan: [plans/2026-11-12-chat-box.md](plans/2026-11-12-chat-box.md). All new names are
Its names were `@experimental` until 0.2 and are settled at 0.2.0; no store change, no migration. It needs core 0.1.6, which has `cw.chat.restrictedBySubject`: the `@chatwarden/http` peer floor on core is `^0.1.6` (raised by hand; player-react, hub-react and
hub-element keep theirs). Known limits, written in the READMEs: rooms are per process (sticky rooms, no cross-process bus); every line is announced
politely in the log, with one tab stop per line; a stored automatic chat timeout reads as a moderator's in `hello` until the next refused line.
Not yet: the site demo adopting the box, and the site headline (after the release is on npm). The pacing words are in the box and are shown by 0.1.8's flood control (below).

- **K7a: flood control and signals** (0.1.8), built and reviewed on branch `flood-signals` (PR #29; shipped once merged, then tagged by the owner). **Slow mode, a burst limit and repeat refusal** per room and
  player, off until set (code, or the hub: Settings, Advanced), with new refusal reasons `slow_mode`, `flood` and `duplicate` and a `retryAfterMs`, a
  per-room override (`cw.rooms.setPace`) and the chat box and `RestrictedChatLine` wording them. **Signals**: what a game records about a player
  (`cw.signals.record`, counted by distinct source, never acting on their own) feeding four switches, each off by default: the Person page record, the
  queue order, the ladder suggestion and the AI read's context. SQLite migration 21 (one-way: back up first); the in-memory store opts in with
  `withMemorySignals`. `GET /policy/profile` also reports `limits` (the chat rate and the signals retention). Known limits, written in the READMEs: pacing
  state is per process; a signal is a fact a game reports, so several real accounts that agree can still count. `examples/tiny-chat` shows slow mode
  with `CW_DEMO_PACE=1`. The site wording waits until the release is on npm and has run in Moxgate.

- **K7b: appeals and offensive names** (0.1.9), built and reviewed on branch `appeals-names`; version prepared, not merged or published (the owner tags it: see
  [RELEASING.md](../RELEASING.md)). Design: [design/2026-11-12-appeals-and-names.md](design/2026-11-12-appeals-and-names.md). **Appeals**, off until turned on
  (`profile.appeals`, or the hub: Settings, Advanced): a player asks for a second look from a sanction notice (up to 1000 characters, one appeal for each
  sanction), a different moderator keeps it, makes it lighter or removes it (`appeals.decide`, a senior by default; `same_decider` is enforced in the core, with
  `allowSelfReview` for a team of one), and the player gets a plain message. In the hub it is a view of the Cases queue, not a second tab. A revoke feeds the AI as a
  corrective example, and a per-rule mistake rate (revokes only: a reduction is not a false positive) sits behind Settings, Advanced, "Mistakes by rule". **Names**:
  a profanity pass on the name check, blocked names kept as evidence (opt-in, 30 days), a moderator can ask for a new name (`rename.required`, `pendingRename`,
  `renamed`: the game must act on it), and **names the word list flags are hidden in the hub until shown, on by default (`names.maskInHub`), the one default-on
  display change**. SQLite migration 22 (one-way: back up first); the in-memory store opts in with `withMemoryAppeals` and `withMemoryNames`. The AI prompt
  version is 4, so every AI-enabled kit re-reads its open reports once after upgrading. New events `appeal.created`, `appeal.decided` and `rename.required`
  (webhooks, the Discord feed for the first two). Known limits, written in the READMEs: a team that shares one login cannot be told apart from a team of one;
  the kit never learns a player's new name. `examples/tiny-chat` shows both with `CW_DEMO_APPEALS=1`. Size budgets raised for it: `player-react` 11 to 14 KB and the
  hub's first load 82 to 88 KB (gzipped). The site wording waits until the release is on npm and has run in Moxgate.

## K4b: fast adoption (0.1.10; built and reviewed on branch `k4b-adoption`; published)
With `@chatwarden/http` installed (`npm install @chatwarden/http`), `npx chatwarden init` writes the wiring for a moderated server: the `chatwarden` bin of `@chatwarden/http` (also `@chatwarden/http/cli` for a wrapper) asks only what it cannot detect and writes the kit, the mount (Express, Fastify, Next.js route handlers, anything on Web `Request` and `Response`, or the library alone), three starter hooks and a synthetic term pack, with the chat box (over HTTP or your own Socket.IO), the moderator hub and a Discord feed as options. It never edits a file that exists, writes no secret and uses the network only with `--install`; `--json`, `--yes`, `--dry-run` and `--check` serve an agent or CI. `@chatwarden/http/fetch` adds `toFetch`, the Web `Request` adapter. `@chatwarden/store-memory/testing` is a test kit (a fake clock, a scripted chat simulator and outcome assertions). The recipes are generated files committed as goldens in `examples/recipes`, type-checked and run against real Express, Fastify and Socket.IO in CI, and embedded in [`docs/recipes`](recipes) (Express, Fastify, Next.js and the Web fetch handler, Socket.IO, and a Colyseus page that follows 0.16 and was checked against fakes only). A skill-only Claude Code plugin lives in `agent/claude-plugin`. Design: [design/2026-11-12-k4b-adoption.md](design/2026-11-12-k4b-adoption.md); plan: [plans/2026-11-12-k4b-adoption.md](plans/2026-11-12-k4b-adoption.md). Its names were `@experimental` until 0.2 and are settled at 0.2.0. No core change, no store change, no migration, no new package, no peer-floor change. CI gains a Windows job that runs only the CLI and test-kit tests. Known limits, written in the docs: the generated Next.js and Colyseus files are not run in a real Next or Colyseus; the Next recipe needs a Node process, not serverless. The site wording waits until the release is on npm; no speed is claimed until someone has timed a fresh project (see [plans/follow-ups.md](plans/follow-ups.md)).

## K7: the shared term corpus (0.1.11; Part A, the kit, built on branch `k7-corpus`; published; the service is not deployed, see below)
A signed, versioned, community-kept term list that an adopter can opt in to, plus published calibration and eval sets. **Part A (the kit, 0.1.11)** works with no service and no keys: `@chatwarden/matcher/corpus` (isomorphic: signatures, the index, the bounded zip reader, release parsing and selection, the loader, the eval reader, the share client with its report call) and `@chatwarden/matcher/corpus/node` (`fileCache`, `installationKey`, `startCorpus`); `LiveTerms.syncPack`; the staff routes in `@chatwarden/http` (`GET /community`, refresh, apply, `GET /terms/:id`, lookup, share, report); the hub's Settings > Community list and the two disclosures in the term editor; four names in `@chatwarden/core` (the audit actions `term.share`, `term.report` and `community.apply`, the target type `release`). **No package ships any terms and nothing is on by default**; with no keys the loader answers `no_trusted_keys`. A guard (`scripts/no-corpus-data.test.ts`) and `check:pack` keep corpus data and keys out of git and tarballs. **Part B (the service, `services/corpus`)** is a private workspace the owner deploys with `wrangler`; it is not part of the kit tag and is built after the owner's one-time actions (design section 17). Design: [design/2026-11-12-k7-term-corpus.md](design/2026-11-12-k7-term-corpus.md); plan: [plans/2026-11-12-k7-term-corpus.md](plans/2026-11-12-k7-term-corpus.md). Its names were `@experimental` until 0.2 and are settled at 0.2.0. No store migration, no new package; `@chatwarden/http` and `@chatwarden/hub-react` raise their `@chatwarden/core` peer floor to `^0.1.11` by hand. The site copy changes only after the first real release exists and has been used.

### K7 Part B: the service (`services/corpus`, branch `k7-service`; built and tested, nothing deployed)
The private workspace `@chatwarden/corpus-service` (never published, not part of the kit's tag): the submission API, the review queue and its Access-protected page, reports, the daily purge, and the maintainers' tools. **Built and tested with no Cloudflare account** (D1 and R2 behind small interfaces; D1 through `node:sqlite`), plus one opt-in smoke on D1's own engine through wrangler's local mode (`npm run smoke:d1 -w @chatwarden/corpus-service`). **The release chain:** `seed` (the owner's lists to SQL, outside git) -> `release` (a copy of the database in, the zip out, the real matcher run over every selection of the languages, a diff of ids and counts) -> `sign` (Ed25519, the kit's domain-separated message; keys made by `keygen`, encrypted, never in a git tree, never printed) -> `zenodo` (a new version of the record) -> `publish` (files first, the index last, the sequence only up, read back and verified, a SQL file to record the release) -> `verify-live` (the kit's loader over the public urls). The eval and calibration sets use the same chain (`eval`, with `checkCase` for the privacy rules). A release built, signed and published by the service is read, verified, selected and synced into a `LiveTerms` by the kit's own loader in a test. **The owner's step-by-step is `services/corpus/README.md`**; the privacy draft is `services/corpus/PRIVACY.md`, the data sources' register `services/corpus/SOURCES.md`, the contributors' page [community-list.md](community-list.md). Not done, and the owner's: Cloudflare and Zenodo accounts and terms, the subdomains, Access and the reviewers, the keys and their public halves in `keys.ts`, the seed and the dictionary, the first release.

## K5: integrations with outside tools (0.1.12; the Discord bot, Coop and EOS are built on branch `k5-integrations`; published; the live checks are still the owner's, see below)
Three opt-in integrations, each able to ship alone. Design: [design/2026-11-12-k5-integrations.md](design/2026-11-12-k5-integrations.md); plan: [plans/2026-11-12-k5-integrations.md](plans/2026-11-12-k5-integrations.md). The Discord bot, Coop and EOS names stay `@experimental` at 0.2.0: they were written from the services' documents and have not run against the live services (see "Still the owner's").

- **Discord bot (built, reviewed per task; the live check is the owner's).** `@chatwarden/http/discord` (not in the package root) has `discordBot` and `registerCommands`: a signed
  interactions endpoint (`POST /discord/interactions`, verified over the exact bytes before anything is parsed, one 401 for every failure), `/chatwarden lookup <code>`,
  and, when `actions` is set, two buttons on a report post with a confirm step ("Nothing wrong here", "Apply suggestion"). A click decides through the hub's own path
  (`decideAs`): the role comes from the signed Discord roles, a permanent ban needs `senior`, a case held by another moderator is refused, and a decision made in the
  hub first is answered "already decided". Slow work is answered with a loading message and finished by one follow-up. `@chatwarden/discord` gains the `components`
  option (buttons on the report post only) and strips them when the report closes; if the webhook is not the application's own, the feed logs one
  `chatwarden.discord_components_ignored` and posts without buttons. Setup, the exact `curl`, what each answer says and the security notes are in the
  [`@chatwarden/http` README](../packages/http/README.md#discord-bot). No store change, no migration. Known limits: a restart forgets which post held which buttons, so an
  old post keeps them (a click is answered "already decided"); the bot needs an application-owned webhook, and that a webhook made with the bot is one is not yet
  checked live. **The owner's live check (K5 D10)** is in [plans/follow-ups.md](plans/follow-ups.md).
- **Coop (built, tests against a fake Coop; the live check is the owner's).** `@chatwarden/http/coop` (not in the package root) has `coop(cw, options)`. Each report becomes a Coop job: `report.created` queues one request on the shared delivery queue, and the 201 writes a `cw.links` row (`coop-report`). `evidence` is required, with no default; the reporter's note and the handles are separate switches. A reviewer's decision comes back to `POST /coop/actions`: the RSA signature is verified over the exact bytes before the body is read (both header shapes), then the decision goes through `decideAs` as the configured role with source `coop` and the actor `coop:<email>`. The first decision wins; a repeat is acknowledged, not applied; a callback no moderator made, an unknown action, a missing rule or a refused ban is acknowledged as ignored and logged by reason as `chatwarden.coop_callback_ignored`; a store failure is a 503. `setup.checklist()` says what to create in Coop by hand (Coop has no write API) and `setup.verify()` is a read-only check. An optional `POST /coop/signal` route serves the copy-in plugin in `examples/coop-signal` (private, not a workspace, not published). Setup, options, the three item types, the conflict rules and the security notes are in the [`@chatwarden/http` README](../packages/http/README.md#coop). **Nothing has run against a real Coop:** the shapes are from Coop's public docs, and a few are marked UNVERIFIED in the code and the README (the signature header shape, whether Ignore sends a callback, `creator` and `datetime`, the plugin types). **The owner's live check (K5 C8)** is in [plans/follow-ups.md](plans/follow-ups.md).
- **EOS (built, tests against a fake EOS; the sandbox check is the owner's).** `@chatwarden/http/eos` (not in the package root) has `eos(cw, options)`. **Push:** a kit sanction of a kind you named becomes an EOS sanction (your action name, source `chatwarden`, the length in seconds, tags `cw` and `rule<n>`, metadata `cw_ref`), queued on the shared delivery queue. The justification is the reference code and the rule, never the moderator's reason unless you choose `'reason'`. Before each create it looks for a sanction of the same group in EOS, so a crash cannot make a second one. A revoke removes the EOS sanction. `cw.links` keeps a hash and EOS's `referenceId`, never a product user id. **Pull:** `pollReports()` asks EOS for reports about the players you name (EOS cannot list all reports) and files a kit report only when your `seatOf` seats both players in the same room. It dedupes by a hash, keeps a cursor that never passes now plus a minute, handles at most `maxPerPoll` new reports a poll, and reads the `context` only for a short `lineId`. The token is held in memory until 60 seconds before it expires, and one 401 refreshes it. Logs are `chatwarden.eos_failed`, `chatwarden.eos_dropped` and `chatwarden.eos_report_skipped`, by class and count only. Setup, options, the two functions you write, the limits and the security notes are in the [`@chatwarden/http` README](../packages/http/README.md#epic-online-services). **Nothing has run against the real EOS:** `duration: 0` as permanent, the batch limit for `reportedPlayerId`, the rate limits and the error bodies are marked UNVERIFIED in the code and the README. Known gap: a restart between the kit's revoke and the EOS delete leaves the EOS sanction until it expires. **The owner's sandbox check (K5 E5)** is in [plans/follow-ups.md](plans/follow-ups.md).

## AI levels 3 and 4, release 1: the seams and the read-only gate dashboard (0.1.13; built on branch `ai-act-r1`; published)
The AI still never acts: nothing in this release lets it write a sanction, a notice or a decision. R1 lays the seams that acting (R3) will need and shows the numbers that would decide it. Design: [design/2026-11-12-ai-levels-3-4.md](design/2026-11-12-ai-levels-3-4.md); plan: [plans/2026-11-12-ai-levels-3-4.md](plans/2026-11-12-ai-levels-3-4.md). Its names were `@experimental` until 0.2 and are settled at 0.2.0.

- **The seam is structural.** The AI module holds a frozen object with only the AI store methods plus `loadReport`, `listReports` and `aiGateRows`, each calling through to the real store (`requireAiStore`), so at runtime it has no writer to reach; `AiStore` has no writer either. A lint rule backs that up: it keeps `packages/core/src/ai/**` to an allowlist of read-only imports and forbids the store's writers there (member, computed, `Reflect`, spread, cast and alias access too); `scripts/ai-seam.test.ts` allows `source: 'ai'` only under `core/src/aiActor/`. The internal source `ai` is refused by `validate()`, which every sanction writer shares (the exported `applySanction` and `validateSanctionInput` among them), unless the kit's own actor holds a private key, and by `cw.decide` and `cw.sanctions.apply`. A decision from an integration (the `api`, Coop or auto filter source) is filed as `service`, not as a person's.
- **The gates, pure.** `evaluateCell`, `wilsonLower`, `wilsonUpper`, `checkGateConfig` and the bands (`@chatwarden/core`); `cw.ai.gates()` reads the casebook on the server and returns one row per rule and conduct level the profile could ever act on, with each gate's number against its need and the reach preview. The G8 keep gate is a loss test on the lower bound (design ruling 22).
- **Do not automate.** `cw.people.automation.get/set` (a closed reason code, no free text, follows a merge), `AUTOMATION_CODES`, `automationAllowed(person, lookup?)` (fail closed). Reads and drafts are still produced for a marked person.
- **Store and migration 24 (SQLite, one-way: back up first).** Five columns and an index on the casebook, and the table `kit_ai_noauto`. The optional store methods `aiGateRows`, `setNoAutomation` and `loadNoAutomation`; memory store through `withMemoryAi`. One shared contract suite, `test/contract/ai-act.contract.ts`.
- **Routes and permissions.** `GET /ai/gates` (`policy.read`, audited `policy.view`), `PUT /people/:id/automation` (`automation.write`, a senior's), and `GET /people/:ref/history` carries `automation` only while a mark is set. Three lowerable permissions: `ai.review` (moderator), `ai.pause` (senior), `automation.write` (senior); the first two are unused until R2 and R3. New audit action `person.automation` (a person target, no detail).
- **The hub.** Settings > AI > Advanced > "Where the AI may act": a read-only table (each gate a tick or a cross with its number against the need, the reach, the cooling date; cells the AI can never act on collapsed with the reason) and the line "Acting is not available in this version". The Person page gets a quiet "do not automate" line and, for a senior, a `...` item. Nothing is added to Simple mode, the case card or the queue. Checked in Chromium at 1280 and 360 px, light and dark.
- **Next.** R2 (shadow: everything runs, nothing is written to a player) after appeals has run; R3 acting; R4 Watch. Follow-ups, decided and open: [plans/follow-ups.md](plans/follow-ups.md).

## AI levels 3 and 4, release 2: shadow mode (0.1.14; built on branch `ai-act-r2`; published)
Everything runs, nothing is written to a player. **Nothing in this release writes a sanction, a notice, a strike, a mute or a decision.** The AI reads, decides what it would have done, asks a second reader and records "would have acted" in a table of its own, so the owner can read that list before R3 lets it act. Design: [design/2026-11-12-ai-levels-3-4.md](design/2026-11-12-ai-levels-3-4.md); plan: [plans/2026-11-12-ai-levels-3-4.md](plans/2026-11-12-ai-levels-3-4.md). Its names were `@experimental` until 0.2 and are settled at 0.2.0.

- **The acting state.** `cw.ai.acting` (`state`, `startShadow`, `startActing`, `pause`, `resume`, `off`) over one store row, moved by a conditional write so of two processes one wins. The owner's steps need the word `ACT` and a reason; shadow must run `ai.act.caps.shadowDays` (14, band 7 to 60) before `startActing`. The code can pin it off (`ai.act.enabled: false`, `maxLevel` below 3). In this release `on` records exactly what `shadow` records. The policy layer still refuses `ai.level` 3 or 4 ("use the acting switch"), and no layer can move the state.
- **The act path.** `ActPath` in the AI module (`consider` after a read, the sweeper's `advanceDue`) queues a candidate for the hold, records the 20% holdback, or records a hard stop as refused with a closed code. After the hold it asks the confirming read (a clean prompt, its own version) and hands the actor three ids. `AiActionService.propose` in `aiActor` loads everything from the store again, runs every check of design 4.2, and records one `shadow` row and one `ai.act` audit row. **The sanction-writing branch is absent**: a store proxy test sees no writer called, and the SQLite end-to-end test counts the rows of every table that could hold one. The AI module's store handle has no `setAiActingState`, and its `transitionAiAction` may only refuse a queued row or record the confirming read.
- **Routes and permissions.** `GET /ai/acting`, `POST /ai/acting/shadow|start|resume|off` (the owner's, compared in code, so the `permissions` option cannot lower them), `POST /ai/acting/pause` (`ai.pause`), `GET /ai/actions` (`ai.review`). No new permission key. Each step writes one `ai.acting` audit row; `ai.act` is the AI's own.
- **Store and migration 25 (SQLite, one-way: back up first).** `kit_ai_reads.purpose`, `kit_ai_acting`, `kit_ai_actions` and five indexes. Optional `Store` methods for the state and the rows, one shared contract suite (`test/contract/ai-shadow.contract.ts`), retention `aiActionsMs` and `purge().aiActions`. **Prompt version 5, and the input hash includes the purpose: every AI-enabled kit reads its open reports once more after the upgrade**, at 5 a sweep inside the daily caps (spend).
- **The hub.** Settings > AI: an Act option (shown only to the owner, and only when the server's code allows acting; absent for everyone else, shown off with the one reason when the owner is missing appeals or the level), one dialog that begins with what this release does (it only records what it would have done) and then lists what it will do, will not do, what the player is told, what the team must do, that the first days are shadow, then `ACT` and a reason), a status line with Pause (a senior, one click), Resume and switch off (the owner), and under Advanced "Would have acted": a plain list with no buttons and no export. Nothing is added to Simple mode, the case card or the queue. Checked in Chromium at 1280 and 360 px, light and dark.
- **The owner's gate before R3.** R3 starts only after 14 days of shadow in a real game, after the owner has read the "would have acted" list, and with appeals in use. That is the owner's call, not a task: see [plans/follow-ups.md](plans/follow-ups.md).

## Names in reports and "What the player sees" (0.2.0 theme; built on branch `release-0.2.0`; not released)

Design: [design/2026-11-17-names-in-reports-and-player-preview.md](design/2026-11-17-names-in-reports-and-player-preview.md); plan: [plans/2026-11-17-names-and-preview.md](plans/2026-11-17-names-and-preview.md). Part of the 0.2.0 release; the release prep does the version, changeset and peer floors.

- **A player can report a name.** The default reason `name` ("Inappropriate name", CR 7, group Chat) is the 11th default.
- **A rename always cites a numbered rule.** `cw.names.requireRename` and `POST /people/:ref/rename` require `rule`; the slur filter's rule is no longer a fallback. Both hub forms require it.
- **A decision can ask for a new name.** `POST /reports/:id/decide` takes `rename: { rule }` and answers `rename: { status: 'asked' | 'already' | 'failed' }`; the decision is written first, the rename asked after it, in one request. A replay never asks twice, even after the player has renamed. In the hub: a quiet row in the decision bar ("Ask for a new name"), at once on a `name` report, behind the editor for any other, with a one-line hint when renames are off.
- **One source of words.** `@chatwarden/core/notice-copy` holds the notice words, `noticeView`, the date formatters, `communityRuleLabel`, `planNotices` and `appealReplacementEnd`. player-react renders from it and spreads `NOTICE_WORDS` into `en` (no visible change); a parity suite runs the real services against `planNotices`.
- **"What the player sees".** A lazy panel in every action that sends or withholds a notice: the decision bar and Simple's card, the Person forms, revoke and the appeal card (now a choice plus "Send decision"). No moderator-only field is ever an input to it.
- **Not done here:** a real-browser pass at desktop and 360 px, light and dark (the tests hold the structure, the wrapping rules and axe), and everything in follow-ups under "Names and the preview (0.2.0), parked".

## Urgent lane, a kinder desk and rooms under attack (0.2.0 theme; built on branch `release-0.2.0`; not released)

Design: [design/2026-11-17-urgent-desk-and-rooms.md](design/2026-11-17-urgent-desk-and-rooms.md); plan: [plans/2026-11-17-urgent-desk-and-rooms.md](plans/2026-11-17-urgent-desk-and-rooms.md); adopter guides:
[recipes/urgent-and-welfare.md](recipes/urgent-and-welfare.md), [recipes/raids.md](recipes/raids.md) and [recipes/digest.md](recipes/digest.md). Part of the 0.2.0 release; the release prep does the changelog, the peer floors and the version.

- **The urgent lane.** A report is urgent from its reason (`threat` by default) or when a moderator marks it; urgent cases sort first in the queue and in take next (never over a claim), are never closed
  by a bulk dismissal, and a default `welfare` reason (switched off) is never held against the reporter. The hub has one chip, a case strip and a "What to do" panel (the owner's guidance and
  studio contact); "I passed this to our safety team" records who and when and emits an ids-only `report.handoff`. The kit decides nothing and contacts no one.
- **The desk.** Staff comments, a second look and escalation (`desk.workflow`), Insights and a digest (`desk.insights`; the adopter calls `emitDigest`), a careful view that hides excerpts until opened
  (browser-only), and a Desk, Safety and Rooms panel in Settings, Advanced.
- **Rooms under attack.** Lock, emergency mode and retraction (`cw.rooms`, per process, always expiring), probation for new accounts, a report-surge hint, linked-account counts and a gameplay-evidence
  link. Chat wire version 2 carries the `mode` and `retract` frames; the chat box shows the mode and a removed line.
- **Store and migration 26.** One shared migration for the release: this theme's block holds the urgent, hand-off, escalation and evidence columns, `kit_report_comments` and `kit_chat_days`.
- **Not done here:** a real-browser pass at desktop and 360 px, light and dark, for the chip, the strip, the careful view and the Rooms panel (the tests hold the structure, the wrapping rules and axe),
  and everything under "Urgent lane, desk and rooms (0.2.0), parked" in [plans/follow-ups.md](plans/follow-ups.md).

## Many rooms, many players and unspaced scripts (0.2.0 theme; built on branch `release-0.2.0`; not released)

Design: [design/2026-11-17-any-server-rooms-languages.md](design/2026-11-17-any-server-rooms-languages.md); plan: [plans/2026-11-17-any-server-rooms-languages.md](plans/2026-11-17-any-server-rooms-languages.md); adopter guides:
[recipes/kids-rooms.md](recipes/kids-rooms.md), [recipes/creator-channels.md](recipes/creator-channels.md) and [recipes/service-mode.md](recipes/service-mode.md). Part of the 0.2.0 release; the release prep does the changelog, the peer floors and the version. This entry covers
tasks M1 to M7, L1, L2 and S1 to S6; the Spanish and Portuguese catalogues (L3, L4) are later tasks of the same plan and add to it.

- **Contexts.** Rules per room, declared in code (`profile.contexts`) and chosen by a room's `context` tag: profanity handling, pace, filters and `chat.phrases`, a minimum account age, and nothing else. A tag
  the profile does not declare refuses every line `gate`. The hub shows the label on a case and a read-only "Room contexts" list in Settings, Advanced (contexts are never edited in the hub).
- **Staff scope.** A second reserved tag, `scope`, stamped on the report; the staff hook may return `scope: string[]` and then every route is default-deny: scope-aware routes filter in the store query, an
  out-of-scope id is 404, the rest of the staff API is 403, and a scoped sanction is a warning or a chat restriction for at most 7 days tied to an in-scope report (`scopedLimits`). The owner cannot be scoped.
- **Block.** A mute that is also two-way and never expires (`cw.blocks`, one row per pair in `kit_mutes`); the game asks `between` with raw ids and cannot list who blocked whom. The chat box offers it behind the line's one control.
- **Phrase-only chat.** Phrase books are code-declared trusted text (`phrases`), screened at start through the matcher and every profanity filter; `cw.chat.acceptPhrase` and `POST /rooms/:room/phrases` send one,
  typed text is refused `phrases_only`, and the chat box shows a phrase picker (catalogue `phrase.<id>` for other languages). The kit ships no phrase text.
- **Reserved names and entities.** `names.reserved` and `names.reservedAllow` compare skeletons over whole words of a name (`name_reserved`, a third name reason); a name, a report and a rename can be about an
  entity (a clan, guild, team, deck, pet or item): `ReportInput.entity`, `kind` on `POST /names/check`, an entity row on the case, and a rename that writes no notice. The `impersonation` reason ships switched off.
- **Terms without spaces.** Matching for Chinese, Japanese, Thai, Lao, Khmer and Burmese: NFKC (not NFKD), kana folded, segmenter-aligned `segment` by default and `contains` by choice (`matchMode`), stored on the
  term (`kit_terms.match_mode`), in the staff routes, the hub's "Match" choice and the corpus loader. A missing `Intl.Segmenter` is a build error.
- **Service mode.** `@chatwarden/http/service` is the `/v1` API over the kit for a game server in any language: service keys (one to five, compared by digest, a throttle on failures), a per-key rate limit, a 64 KiB body cap,
  `Idempotency-Key` on lines, phrases and reports, a handshake with warnings, sixteen routes (seats, lines, phrases, mutes and blocks, reports, notices, record, restriction, names, doors, blocks between), `SERVICE_OPENAPI`
  built from the same route descriptions, and `createServiceClient`. `chatwarden serve` is the process (the Node bridge with a byte cap and a read timeout, the init starter's shared-token staff sign-in or your own auth module, the hub page,
  `/healthz` and `/readyz`, a fixed startup order that refuses with one sentence and never a value, a graceful stop); `chatwarden init --service` writes the Docker recipe folder. `examples/service` (the recipe, `curl.sh`, `conformance.mjs`,
  `expectations.json`) and `examples/service-csharp` (a client and a demo that read the same expectations); CI builds the sample and runs it against a live service. A scoped moderator reads `GET /policy/rules` (the rule list alone) to act on a case.
- **Shared pacing.** `createChatwarden({ sharedPacing: true })` keeps the pacer's state in the store (`kit_pace`, `paceLoad`, `paceUpdate`, `paceDropRoom`, `paceSweep`), so several processes judge one player's lines together; `decide` and
  `commitState` are pure functions both pacers call and a test runs one script through both. It is a deployment flag, not a profile setting; `setPace` overrides, seats, evidence and the fixed rate stay per process.
- **Store and migration 26.** The same shared migration: this theme's blocks add `kit_reports.scope`, `kit_reports.entity_json`, `kit_mutes.block`, `kit_terms.match_mode` and `kit_pace`. A store missing an optional method answers 501 `not_supported`.
- **Not done here:** everything under "Rooms, many players and unspaced scripts (0.2.0), parked" in [plans/follow-ups.md](plans/follow-ups.md).

## Next
- **K3c: AI levels 1-2** (read and recommend), **done**: merged as 0.1.7 (PR #26; tag and publish are the owner's). The AI reads a report after the
  player's ack, shows a strip in the hub and, at level 2, pre-fills a mild decision the moderator accepts or edits; it never writes a sanction. Off by
  default, per instance, with a daily money cap in code and an owner-set call ceiling. Every human decision becomes a casebook example; revoked appeals
  become corrective examples and feed a per-rule false-positive rate (0.1.9; a reduction on appeal is not a false positive). The site wording that says it is available is prepared and not
  published (see [plans/follow-ups.md](plans/follow-ups.md)).
- **K6b-d: Moxgate adopts the hub and player UI.**
- **Roadmap items** chosen 2026-11-10: slow mode, flood control and generic game signals shipped as 0.1.8, and an appeals inbox and offensive names as 0.1.9
  (both above). Nothing from that list is left to build.

  Sketches: [design/2026-11-10-editable-ladder-and-roadmap.md](design/2026-11-10-editable-ladder-and-roadmap.md), Part 2.
- **Later phases:** K4d service mode (the generated service for non-Node servers), K7 the shared term corpus, K5 integrations (Discord bot, Coop, EOS), and AI levels 3 and 4 (acting on clear cases, and watching); each has a design note and a plan under `docs/`.

## 0.1.5
Version prepared (`npm run version` run, peer floors raised by hand, `check:pack` and the smoke test green), not merged or published (the owner tags it: see [RELEASING.md](../RELEASING.md)). Faster report triage, all additive (a patch), on branch `triage-speed`:
- **Dismiss.** `reason` is optional for a `no_action` decision with no actions; the kit stores the standard reason `No action needed`
  (`NO_ACTION_DEFAULT_REASON`). The hub's "Nothing wrong here" sends none. Every quick action moves on to the next case; Undo still works
  after the move and `U` undoes the newest waiting decision.
- **Bulk dismiss.** `cw.reports.dismissMany`, `POST /reports/dismiss-open`, new permission `reports.decide.bulk` (moderator), audit actions
  `report.dismiss_case` and `report.dismiss_reporter` beside one `report.decide` row per report. Never marks bad faith. Behind "Close more
  reports at once" in the hub, held for the five-second Undo.
- **Reporter accuracy.** `cw.reports.reporterAccuracy` (30 days, minimum 5 decided), a line on the case, and a lower place in the queue and
  in take-next for habitual false reporters (80% or more; reports over 24 hours old rank normally). Staff only; nothing is hidden.
- **Keyboard queue mode.** J/K and the arrow keys, 1/2/3 act, U undoes; "Quick keys" (on in Simple, off in Detailed).
- SQLite migration 19 adds one index. Peer floors rise to 0.1.5 for `store-memory`, `store-sqlite`, `http` and `hub-react` on core, and for
  `hub-react` on `http`. The hub's first load stays under its 76,800 byte budget (the command bar, shortcut sheet and bulk window load on demand).
- Parked (see "Open follow-ups"): a server-side reopen of a dismissed report; dropping `kit_reports_by_reporter` (a prefix of the new
  index) in a minor; putting the accuracy thresholds in `limits.reports`; an owner view of reporter accuracy (deliberately not built: no
  per-person leaderboards); bulk by room or reason; J/K open-on-move in the `CaseList` piece; a keyup arm for act keys for hosts that send
  repeated keydowns with `repeat: false`; the held-toast progress bar restarting when an older toast returns to view.

## 0.1.3
Ready, not published (the owner tags it: see [RELEASING.md](../RELEASING.md)). A hardening patch on branch `hardening-0.1.3`:
- The matcher no longer ships obscenity's English word list to browsers (issue #8), and `obscenity` is a devDependency of the matcher.
- SQLite migration 18: indexes on `kit_sanctions(starts_at)` and `kit_strikes(at)`.
- Hub: a refresh handle (`onController`, `controller.refresh()`) and the settings and admin screens load on demand.
- Players report in one step (reason and note inline); `onAddDetail` is deprecated and no longer called; the `extra` slot is part of the API.
  The "What players see" picture in the hub shows it. Nothing was removed from the exported catalogues (the unused words are deprecated).
- The site demo follows the one-step dialog and no longer scrolls sideways at 320 px; its word-list workaround is gone.

## Open follow-ups
- `/sanctions` makes one reports read per person (bounded at 200).
- Unsaved settings are not guarded against the browser Back button or a typed URL (documented).
- hub-element ships two near-identical bundles (`dist/hub-element.js` and `dist/index.js`, about 684 KB each). Left as it is in 0.1.3:
  making `hub-element.js` a two-line module that imports `./index.js` would break the documented one-file use (the README tells people to
  copy that one file, "no imports, so it works from any path"), add a second request in series on a CDN, and change what a patch ships.
  Do it in a minor, with the README and the CSP notes changed with it.
- Remove the deprecated words from `en` and `PlayerText` (player-react) and the six preview words of the hub's `en`, and the
  `onAddDetail` prop, in a later minor.
- Parked items from earlier phases: [plans/follow-ups.md](plans/follow-ups.md).
