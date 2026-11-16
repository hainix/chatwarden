# Status

Updated 2026-11-12. The full roadmap and the reasoning behind it: [design/2026-11-09-product-scope.md](design/2026-11-09-product-scope.md).

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

## Chat box (0.1.6; merged, PR #23; tag and publish are the owner's, see [RELEASING.md](../RELEASING.md))
A game with no chat adds moderated chat in minutes: `@chatwarden/http` gains a room broadcaster and four routes (Server-Sent Events down, `POST`
up; `@chatwarden/http/chat`), `@chatwarden/player-react` gains `<ChatBox>` and `sseTransport` at the lazy subpath `@chatwarden/player-react/chat`
(its own words, `enChat`, and `chat.css`), and `examples/tiny-chat` has a browser page that uses them. Design:
[design/2026-11-12-chat-box.md](design/2026-11-12-chat-box.md); plan: [plans/2026-11-12-chat-box.md](plans/2026-11-12-chat-box.md). All new names are
`@experimental` until 0.2; no store change, no migration. It needs core 0.1.6, which has `cw.chat.restrictedBySubject`: the `@chatwarden/http` peer floor on core is `^0.1.6` (raised by hand; player-react, hub-react and
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

## K4b: fast adoption (0.1.10; built and reviewed on branch `k4b-adoption`; version prepared, not merged or published)
With `@chatwarden/http` installed (`npm install @chatwarden/http`), `npx chatwarden init` writes the wiring for a moderated server: the `chatwarden` bin of `@chatwarden/http` (also `@chatwarden/http/cli` for a wrapper) asks only what it cannot detect and writes the kit, the mount (Express, Fastify, Next.js route handlers, anything on Web `Request` and `Response`, or the library alone), three starter hooks and a synthetic term pack, with the chat box (over HTTP or your own Socket.IO), the moderator hub and a Discord feed as options. It never edits a file that exists, writes no secret and uses the network only with `--install`; `--json`, `--yes`, `--dry-run` and `--check` serve an agent or CI. `@chatwarden/http/fetch` adds `toFetch`, the Web `Request` adapter. `@chatwarden/store-memory/testing` is a test kit (a fake clock, a scripted chat simulator and outcome assertions). The recipes are generated files committed as goldens in `examples/recipes`, type-checked and run against real Express, Fastify and Socket.IO in CI, and embedded in [`docs/recipes`](recipes) (Express, Fastify, Next.js and the Web fetch handler, Socket.IO, and a Colyseus page that follows 0.16 and was checked against fakes only). A skill-only Claude Code plugin lives in `agent/claude-plugin`. Design: [design/2026-11-12-k4b-adoption.md](design/2026-11-12-k4b-adoption.md); plan: [plans/2026-11-12-k4b-adoption.md](plans/2026-11-12-k4b-adoption.md). All new names are `@experimental` until 0.2. No core change, no store change, no migration, no new package, no peer-floor change. CI gains a Windows job that runs only the CLI and test-kit tests. Known limits, written in the docs: the generated Next.js and Colyseus files are not run in a real Next or Colyseus; the Next recipe needs a Node process, not serverless. The site wording waits until the release is on npm; no speed is claimed until someone has timed a fresh project (see [plans/follow-ups.md](plans/follow-ups.md)).

## K7: the shared term corpus (0.1.11; Part A, the kit, built on branch `k7-corpus`; version prepared, not merged or published)
A signed, versioned, community-kept term list that an adopter can opt in to, plus published calibration and eval sets. **Part A (the kit, 0.1.11)** works with no service and no keys: `@chatwarden/matcher/corpus` (isomorphic: signatures, the index, the bounded zip reader, release parsing and selection, the loader, the eval reader, the share client with its report call) and `@chatwarden/matcher/corpus/node` (`fileCache`, `installationKey`, `startCorpus`); `LiveTerms.syncPack`; the staff routes in `@chatwarden/http` (`GET /community`, refresh, apply, `GET /terms/:id`, lookup, share, report); the hub's Settings > Community list and the two disclosures in the term editor; four names in `@chatwarden/core` (the audit actions `term.share`, `term.report` and `community.apply`, the target type `release`). **No package ships any terms and nothing is on by default**; with no keys the loader answers `no_trusted_keys`. A guard (`scripts/no-corpus-data.test.ts`) and `check:pack` keep corpus data and keys out of git and tarballs. **Part B (the service, `services/corpus`)** is a private workspace the owner deploys with `wrangler`; it is not part of the kit tag and is built after the owner's one-time actions (design section 17). Design: [design/2026-11-12-k7-term-corpus.md](design/2026-11-12-k7-term-corpus.md); plan: [plans/2026-11-12-k7-term-corpus.md](plans/2026-11-12-k7-term-corpus.md). All new names are `@experimental` until 0.2. No store migration, no new package; `@chatwarden/http` and `@chatwarden/hub-react` raise their `@chatwarden/core` peer floor to `^0.1.11` by hand. The site copy changes only after the first real release exists and has been used.

### K7 Part B: the service (`services/corpus`, branch `k7-service`; built and tested, nothing deployed)
The private workspace `@chatwarden/corpus-service` (never published, not part of the kit's tag): the submission API, the review queue and its Access-protected page, reports, the daily purge, and the maintainers' tools. **Built and tested with no Cloudflare account** (D1 and R2 behind small interfaces; D1 through `node:sqlite`), plus one opt-in smoke on D1's own engine through wrangler's local mode (`npm run smoke:d1 -w @chatwarden/corpus-service`). **The release chain:** `seed` (the owner's lists to SQL, outside git) -> `release` (a copy of the database in, the zip out, the real matcher run over every selection of the languages, a diff of ids and counts) -> `sign` (Ed25519, the kit's domain-separated message; keys made by `keygen`, encrypted, never in a git tree, never printed) -> `zenodo` (a new version of the record) -> `publish` (files first, the index last, the sequence only up, read back and verified, a SQL file to record the release) -> `verify-live` (the kit's loader over the public urls). The eval and calibration sets use the same chain (`eval`, with `checkCase` for the privacy rules). A release built, signed and published by the service is read, verified, selected and synced into a `LiveTerms` by the kit's own loader in a test. **The owner's step-by-step is `services/corpus/README.md`**; the privacy draft is `services/corpus/PRIVACY.md`, the data sources' register `services/corpus/SOURCES.md`, the contributors' page [community-list.md](community-list.md). Not done, and the owner's: Cloudflare and Zenodo accounts and terms, the subdomains, Access and the reviewers, the keys and their public halves in `keys.ts`, the seed and the dictionary, the first release.

## K5: integrations with outside tools (0.1.12; the Discord bot, Coop and EOS are built on branch `k5-integrations`; version prepared (changeset consumed, floors set, `check:pack` and smoke green), not merged, tagged or published)
Three opt-in integrations, each able to ship alone. Design: [design/2026-11-12-k5-integrations.md](design/2026-11-12-k5-integrations.md); plan: [plans/2026-11-12-k5-integrations.md](plans/2026-11-12-k5-integrations.md). All new names are `@experimental` until 0.2.

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
- Hub: a refresh handle (`onController`, `controller.refresh()`, experimental) and the settings and admin screens load on demand.
- Players report in one step (reason and note inline); `onAddDetail` is deprecated and no longer called; the `extra` slot is experimental.
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
