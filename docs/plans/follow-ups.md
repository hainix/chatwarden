# Follow-ups

Things found while building, not yet done. Each one names where it came from.

## Done: `@chatwarden/matcher` shipped obscenity's English word list to browsers (issue #8)

Found building the landing-page demo (K8b, 2026-11-10). Fixed in 0.1.3.

- **Problem.** `@chatwarden/matcher` was built on `obscenity`. Its CommonJS build has no `sideEffects` flag, so a browser bundler kept
  `englishDataset` (obscenity's ready-made English list, which holds real slurs) even though the matcher never used it: the matcher
  builds its own dataset from the term pack.
- **Fix.** The matcher carries the few pieces it used (`src/vendored/wordEngine.ts`), so `obscenity` is a devDependency, used only by
  the parity and version-pin tests. `scripts/browser-bundle.test.ts` and `site/test/dist.test.ts` check that a browser bundle and the
  built page hold no trace of the preset. The site workaround (`withoutObscenityWordList`) was removed.

## Open: landing-page follow-ups after the copy rewrite (2026-11-11)

Found writing the copy rewrite (`docs/design/2026-11-11-site-copy-rewrite.md`, built in `site/`).

- **Hero visual.** Replace the chat-only mock with a two-frame visual: a chat line with a Report tap, then the one-card hub view
  ("Restrict chat, 24 hours"). The copy does not need it. (Ruling 11.)
- **Hub wording.** The hub's own suggestion text in the demo is jargon ("Standard profile: severe conduct is acted on at once, never
  below the first-offense outcome or the ladder step for the record: restrict chat 7 days"). It is hub-react's `en` catalogue and wants
  the same plain-words pass. The hub also shows two Undo controls at once (the card's and the toast). Both are hub-react, not site, work.
- **Hub in the demo's frame.** The hub's light theme inside the dark demo frames looks pasted in. Give it its dark theme inside the
  demo, or frame the hub pane light.
- **"In about 15 minutes".** Someone times a fresh install against `examples/tiny-chat`; if it is under 15 minutes, add it to the
  "Add it to your game" lead. Until then the page makes no time claim. (Ruling 5.)
  **How to time it** (a checklist): start with an empty folder and a stopwatch. `npm init -y` (stopwatch starts), set `"type": "module"`,
  `npm install express @types/express typescript @chatwarden/http @chatwarden/core`, `npx chatwarden init --yes --framework express --store memory`, add the
  one line the init report prints to a small Express app, set `CHATWARDEN_SECRET` and `CHATWARDEN_ADMIN_TOKEN`, start the server, post a line with the
  synthetic blocked word and see it refused (stopwatch stops). Do it three times on a clean machine and write down the slowest. Only a slowest time
  under 15 minutes allows the claim.
- **Chat box on the site.** The chat box is built (see the status page), so the page can promise chat. The headline changes only after the
  release that holds it is on npm; the site demo adopts `<ChatBox>` in its own PR after that. (Ruling 1.)
- **AI section.** It comes back as a section when level 1 ships (the work is on branch `ai-levels`); today it is one FAQ answer. (Ruling 4.)
- **Moxgate mention.** Cut until the Moxgate adoption ships, then "Used in Moxgate" with a link and a screenshot. (Ruling 8.)
- **Non-Node servers.** A chat-check HTTP route would give other server languages a ready path; the FAQ says plainly that there is none. The route is **service mode**, designed next as K4d (the generated service, with `chatwarden init` as the way to get it); the FAQ answer is rewritten when K4b is on npm (Express, Fastify and Next.js are written by `init`, anything on Web `Request` uses `toFetch`).

## Open: left from the review of the landing-page rewrite (2026-11-11)

- **Tour card.** Skip or Close removes the 124 or 184px strip and the panes jump up; reserve the height (or show a slim "Restart the tour"
  strip). The finished card still says "That's the whole loop" and "That's what you add to your game"; "Done. A player reported, you decided,
  and Bo was told why." is plainer.
- **Chat overlay padding.** `.chat-wrap:has(.chat-overlay > *) .chat` adds 96px of bottom padding while an overlay row shows; when the last
  row goes, a chat scrolled to the bottom is clamped and slides down. Keep the padding always, or use `scroll-padding`.
- **Pause** only holds the replies now, which makes it nearly dead UI in a finite room; consider removing it.
- **Phone swipe test.** `.is-stacked .chat` no longer traps a swipe (`overscroll-behavior: auto`); add a 360x640 Chromium test that a swipe
  starting over the chat moves the page.
- **Headline wrap.** "MODERATOR / HUB INCLUDED." splits "Moderator hub"; a non-breaking space would keep it whole. The copy also mixes
  "recognise" and "Licence" (UK) with US spellings elsewhere.
- **FAQ screenshots** show a band of hero-style grid under the sticky header at y 66 to 85 (`faq-1440-light.png`, `faq-390-dark.png`);
  check it is only the screenshot and not a visible seam.
- **Contrast.** Measure the hero fine print (small muted text on the lavender light background) against 4.5:1. The phone tour bar sets its
  title in the display face, all caps, over three lines; consider a shorter title there.

## Triage speed (0.1.5), parked

Found building the triage-speed plan (2026-11-11). Left for later:

- **Server-side reopen** of a dismissed report. The bulk Undo is held on the client before the send; after it there is no undo.
- **Drop `kit_reports_by_reporter`** in a minor: it is now a prefix of `kit_reports_by_reporter_outcome` (migration 19).
- **Tune the accuracy thresholds**: the window (30 days), the minimum sample (5) and the 0.6 and 0.8 rates could move into `limits.reports`.
- **An owner view of reporter accuracy** (a per-reporter list) is deliberately not built: the workbench note forbids per-person leaderboards.
- **Bulk by room, by reason, or by a selection of cases.**
- **J/K open-on-move in the `CaseList` piece** (it has no router, so pieces keep focus-only movement).
- **A keyup arm for the act keys.** Some remote-desktop hosts send repeated keydowns with `repeat: false`; ignoring digits until one `keyup` has been seen after a case mounts would close that.
- **Held-toast progress bar** restarts from full when an older held toast comes back into view (it needs a start time on `ToastRecord`).
- **A cache-busting retry** (`?retry=`) for a lazy window that failed to load; today the README says to reload the page.

## AI levels 1 and 2 (0.1.7), parked

Decided in [design/2026-11-11-ai-levels-1-2.md](../design/2026-11-11-ai-levels-1-2.md) to come later, as compatible additions:

- **Site wording.** The text that says levels 1 and 2 are available (and the FAQ "Does an AI read my players' chat?") is written in
  `site/src/content.ts` behind `AI_LEVELS_AVAILABLE`, which stays `false`. Flip it, and the "coming" tests with it, only after 0.1.7 is on npm
  and Moxgate has run it (design question 10). The site is deployed by hand, so nothing shows until then.
- **Batch backfill.** The Batch API halves the price but is not live; it is the right tool for reading the reports already open the day the AI
  is switched on.
- **Blind sampling.** Hiding the AI on a few percent of cases to measure automation bias. Not yet: the agreement and one-click rates are recorded,
  so decide with real numbers.
- **`byTag` scope.** The level is per kit instance. If one instance runs several games, a `byTag` map in the `ai` profile section is a compatible
  addition.
- **Signals as AI context.** Flags, mutes and report counts are never sent to the model. If they are ever passed as context, the evidence rule (a
  recommendation to uphold or note needs a cited line by the reported person) still stands. The ranking already uses the reporter's record, as a
  capped weight in the queue and never in the read.
- **"Do not automate".** The mark belongs to level 3 (acting). `automationAllowed(person)` exists and returns true; level 3 backs it with the mark.
- **Levels 3 and 4.** Acting on clear cases and watching are separate designs; the seams are in section 12 of the design note.
- **Done: the memory store's AI methods are opt-in.** `createMemoryStore()` no longer carries them; `withMemoryAi(store)` (`@experimental`) adds
  them, so a browser bundle that never opts in does not either. `scripts/browser-bundle.test.ts` measures the browser build without the AI service,
  its names, the hub's ranking and `withMemoryAi`, and holds its 103 KB budget (102.8 KB). A kit given `ai` over a store without the methods stays
  inert and logs `chatwarden.ai_store_unsupported` once.

## Flood control and signals (0.1.8), parked

- **Webhook action `signal`.** An incoming `POST /webhooks/in/action` for games that are not Node; today `cw.signals.record` runs in process.
- **A signal that lowers a suggestion**, or any effect from a positive kind other than a note or the record.
- **Who meets a rule now.** A hub view of the people who currently meet a rule, a signal preview in the ladder preview, a moderator-side discard of a signal.
- **Per-room settings stored in the kit.** A room override (`cw.rooms.setPace`) lives in the game's process.
- **Shared pacing state across processes.** A store-backed limiter; today route a room's chat to one process.
- **A fan-out guard.** One `by` signalling many subjects in a short time.
- **Signals in webhooks, the Discord feed or any player-facing surface.**
- **A locale other than English** for the new words (the keys are flat, so translations are additive).
- **Site copy.** The public site flips a promise only after the release is on npm and has run in Moxgate.
- **The built-in kind in the hub.** The Signals panel lists only the kinds the game declared; the kit's own "Flooded the chat" is chosen by "All kinds" or
  by a feed written in code. Listing it read-only and letting the record and AI forms pick it is a possible follow-up.
- **Value goldens for the staff bodies.** `admin.bodies-off.test.ts` pins shapes and key lists; a literal JSON golden for `POST /reports/:id/suggest` and
  the `POST /cases/next` case body would also pin values and order.
- **A countdown in the pace line.** `RestrictedChatLine` fixes the end once and shows `player.pace.ready` only if the parent renders again; a live
  countdown is the host's to add (it owns the timer).

## Appeals and names (0.1.9), parked

Decided in [design/2026-11-12-appeals-and-names.md](../design/2026-11-12-appeals-and-names.md), section 9, and found in review.

- **Appeals by reporters**, appeals of notes, or of anything without a notice.
- **A free-text reply to the player**, or a second appeal after a decision.
- **Claims on appeals** (the conditional decide is the guard), and keys for the appeal card.
- **A per-actor or per-role self-review exemption**, routing appeals to a named moderator, and an SLA clock.
- **Auto-expiry of an old open appeal.**
- **The kit holding or checking a player's current name**, automatic renames, and checking names already in the game (a batch scan).
- **A webhook that carries a statement or a name**, and the AI reading a statement or a name.
- **Gates for AI levels 3 and 4.** They will read `cw.appeals.stats()`.
- **A locale other than English** for the new words (the keys are flat, so translations are additive).
- **Site copy.** The public site flips a promise only after the release is on npm and has run in Moxgate.
- **The statement in the kit's process.** `FeedKit.appeals.get` (Discord) copies out two times and drops the rest, but a real kit's `cw.appeals.get` still loads the
  statement in memory first. A narrower core read (the sanction only) would remove that.
- **Casebook marks are per report.** A decision can sanction several people; a revoke of one appeal marks the whole report's casebook row corrective, and a reduced
  replacement carries no `reportId`, so revoking the replacement later cannot upgrade the earlier mark.
- **The gap-note exemption is keyed on the decide token** (`sanctions.ts`, the same token that lets `reportId` through). Internal only, safe today.
- **The appeal card in Detailed shows no name.** `GET /appeals/:id` carries no handle, so Detailed shows the rule chip and the record link and Simple reads the person's
  history once. Adding a `handle` to the detail would let both show it.
- **Settings panels repeat a block.** Four Advanced panels share a discard, reload and reset flow; a `usePanelFlow` would hold it once.
- **A lone U+FE0F statement** cleans to empty and is refused. Intended, listed so nobody reads it as a bug.

## The shared term corpus (0.1.11), parked
Design 20 of [design/2026-11-12-k7-term-corpus.md](../design/2026-11-12-k7-term-corpus.md): not in this release.
- A hub review UI for the corpus, and in-hub sharing of eval cases.
- Non-Latin scripts and languages beyond en, es, pt; per-language matching.
- A `chatwarden terms install` command (K4b's CLI); until then the matcher README shows the short script.
- AI-assisted review of proposed terms.
- Automatic updates that apply without the adopter choosing `apply: 'auto'`.
- A browser build of the loader for the site demo (the code is isomorphic; the demo stays on the synthetic pack).
- The hub's moderator-calibration screen (the sets are published; the screen is its own K4 follow-up).
- Changes to `@chatwarden/profanity`'s own English list. Ordinary swearing stays its job.
- Phrases, regex terms and a `severity` that changes matcher behaviour (it is metadata in this release).
- A public web page listing terms. The service shows counts, versions and statuses; the data is in the signed zips.

Found while building Part A:
- The share status of a term is kept in memory in the http process (1000 terms, lost on restart). A store-backed record would survive a restart and agree across processes.
- The loader keeps the index's ETag in memory only, so a new process fetches the index whole; `state.json` could carry it.
- A cache write failure leaves a verified release unadopted (the previous one stays). A read-only cache folder shows as `failed` / `cache_failed` in the hub.
- The site headline and copy wait for the first real release and some use of it.

Found while building Part B (the service):
- A confirmed `wrong_category` report has no category or target edit action yet: it holds the term out (`disputed`) and the only exit is a two-reviewer restore with the category unchanged. Add the edit to the review page before the first real report is confirmed.


## The Discord bot (K5 / 0.1.12), parked

Found building `@chatwarden/http/discord` (K5 D1 to D9, 2026-11).

- **Open, owner: the live Discord check (task D10).** Nothing has talked to Discord yet; every test uses fakes. Use a throwaway server and a throwaway application, never the
  production one. Do these in order, and write down the answer to each of the first three:
  1. Follow the "Discord bot" setup in `packages/http/README.md` as far as the webhook (steps 1 to 4). Make the webhook with the `curl` there. **Does the answer to a post
     with buttons name your application?** Start the feed with `components: bot.components`, file a test report, and watch the log. If you see
     `chatwarden.discord_components_ignored`, a webhook made with the bot is not application-owned: stop, and tell the maintainer (the plan then adds a bot-token post
     route). If the post shows its buttons, it is.
  2. Deploy the route, paste its URL as the **Interactions Endpoint URL**. **Does Discord accept it when you save?** (It sends a PING; the bot answers it.) If not, check that
     the adapter gives `rawBody` and that no body parser runs first.
  3. Run `registerCommands`, then type `/chatwarden` in the server. **Does the command show for the roles you expect?** The default visibility is Discord's "Moderate Members"
     permission (`1099511627776`); if it is wrong, fix `default_member_permissions` in `bot.commands()` (the role map is the control, not this).
  4. Click "Nothing wrong here" and Confirm, and the same on "Apply suggestion". The feed should post the outcome and take the buttons off.
  5. With `respondWithinMs` set to `1` for one run, click both: (a) "Nothing wrong here" on the public report post, then (b) Confirm on the private preview that (a) opens.
     **For (a), does the public post stay exactly as it was** (same text, same buttons), with only you seeing a loading message that becomes the preview with Confirm and Cancel?
     **For (b), does the preview turn into `Done`?** Write down both. This is the third fact Discord's docs leave open: the bot answers a click on the public post with a private
     loading message (type 5, flags 64) and edits that, so the public post is never rewritten; if the public post changes, tell the maintainer.
  Write the results in `docs/status.md` (K5) when done.
- **Open: strip after a restart.** The feed keeps `report -> message` in memory. After a restart an old report post keeps its buttons until someone clicks one. A small
  table would fix it but costs a migration; not worth it until someone asks.
- **Open: a bot-token post route.** Only if check 1 fails: the feed would post through `POST /channels/{id}/messages` with a bot token instead of a webhook.
- **Open: `registerCommands` needs a bot.** The one-shot script builds the same `discordBot` to call `bot.commands()`. A plain exported list would avoid building a bot with a kit.
- **Open: a redelivered interaction.** Discord rarely sends one twice. The bot answers it from memory, and for a slow one it sends the follow-up again (the same text).

## Coop (K5 / 0.1.12), parked

Found building `@chatwarden/http/coop` (K5 C1 to C7, 2026-11).

- **Open, owner: the live Coop check (task C8).** Nothing has talked to a Coop yet; every test uses a fake written from Coop's public docs. Use a local Coop (never a production one),
  with a throwaway API key. Do these in order, and write down the answer to each of the first five:
  1. Start a local Coop with its own `docker compose` set-up. In Settings, API Keys, make an API key, and copy the **Webhook Signature Verification Key** (a PEM).
  2. Start the kit with `coop(cw, ...)` as in the "Coop" section of `packages/http/README.md`, with `evidence: 'excerpt'`. Call `setup.checklist()` and print its `toText()`. Make
     in Coop exactly what it lists: the three item types with their fields, one policy per Community Rule, and the actions, each with the callback URL (your public URL plus
     `/coop/actions`, for example through a tunnel) and **user strikes off**. Copy the ids into the options. Run `setup.verify()`. **Does it say `complete: true`?** If an
     item type or a field is reported missing, compare the names with the checklist. If Coop uses other names for the field types (the kit says `STRING`, `NUMBER`, `DATETIME`
     and `RELATED_ITEM`), tell the maintainer.
  3. File a test report in the kit. **Does a job appear in Coop? Does it show the lines in order, with `datetime`, and the reported player as `creator`?** If Coop answers 400,
     the log shows `chatwarden.coop_failed` with status 400 and attempts 1: the item type fields differ from what the kit sends. Tell the maintainer which.
  4. Decide the job in Coop with your Warn action. **Does the kit apply it?** The report should close in the hub, the player should get a warning with the source `coop`, and the
     audit trail should show `report.decide` by `coop:<your email>`. **Which signature header did Coop send?** The adapter accepts both shapes, so it works either way; note
     whichever you see (a tool such as the Coop server's own log, or a request catcher on the tunnel, shows it).
  5. Close a job in Coop with **Ignore**, and use "Invalidate reports" on another. **Does the kit get a callback for either?** It should not. If it does, the log shows
     `chatwarden.coop_callback_ignored`; note the reason and tell the maintainer. Also try Move. The report stays open in the hub in each case.
  6. Decide a report in the hub first, then decide its job in Coop. The kit should log `chatwarden.coop_callback_ignored` with reason `closed` and change nothing.
  7. Optional, for the signal: set `signal: { secret, read }` on the adapter, build `examples/coop-signal` (see its README), list it in Coop's `integrations.config.json` by local path
     and fill its form. **Does it appear as a signal in a rule? Does a report job evaluate it?** Compare the plugin's file with Coop's own example plugin
     (github.com/roostorg/coop-integration-example): the return shape of `createSignals`, whether a model card is needed, and the package name of the types (`@roostorg/coop-types`
     in Coop's docs, `@roostorg/types` in its example). Tell the maintainer the differences.
  Write the results in `docs/status.md` (K5) when done.
- **Open: Coop jobs the hub closed first stay in Coop.** The documented API cannot close a job. A reviewer may open a job whose case is settled; the late callback is acknowledged and ignored.
- **Open: Coop appeals, the Partial Items endpoint and `items/async`.** Not built, on purpose (design section 13).
- **Open: after step 4 above, delete the signature header shapes Coop does not send** (the hex `v1`, the `t.body` form or the `t=` form, whichever you saw is absent) from `packages/http/src/coop/verify.ts`, and record the finding in `docs/status.md`. Fewer accepted forms is the safer end state.
- **Open: a bounded signature cache.** Coop's signature has no time, so a replay is harmless only by effect. If Coop ever signs a time, add a window like the signal route's.

## EOS (K5 / 0.1.12), parked

Found building `@chatwarden/http/eos` (K5 E1 to E4, 2026-11).

- **Open, owner: the EOS sandbox check (task E5).** Nothing has talked to EOS yet; every test uses a fake written from EOS's public Web API pages. Use a **sandbox** deployment and
  test players only, never the live one. Do these in order, and write down the answer to each of the first six:
  1. In the Developer Portal, make client credentials for the sandbox deployment. Give the client a policy that allows `sanctions:createSanction`, `sanctions:deleteSanction`,
     `sanctions:findSanctionsForAnyUser` and `playerreports:findReportsForAnyUser`. To send a test report from a script you also need `playerreports:sendReportForAnyUser` on a second client.
     Copy the deployment id, client id and client secret. Keep them out of source control.
  2. Start the kit with `eos(cw, ...)` as in the "Epic Online Services" section of `packages/http/README.md`. Use two test accounts that have EOS product user ids, and give the
     adapter the two functions for them. Use your own action names. Start with `adapter.start()` for the pull.
  3. In the hub, apply a **24 hour chat** sanction to the first test player. **Does it appear in the Developer Portal's sanctions list for that player, with your action name, the
     justification "Chatwarden M-XXXXX, Rule n", the tags `cw` and `rule<n>`, and the metadata `cw_ref`?** If the log shows `chatwarden.eos_failed` with a status, note it.
     A 403 on `op` `reconcile` means the client policy lacks `findSanctionsForAnyUser`.
     This is also the first sanction for that player, so it settles what EOS answers to the user query for a player with no sanctions (the adapter reads a `404` as "none found"). If the sanction is not created and the log shows a status on `reconcile`, note it.
  4. Apply a **permanent ban** to the second test player. **Does it show as permanent (no end time), or does it end at once, or does EOS answer 400?** This settles whether
     `duration: 0` means permanent on create. Tell the maintainer exactly what you see.
  5. Revoke the first sanction in the hub. **Does it disappear from the Developer Portal list within a minute (status Removed)?** Revoke the second too.
  6. Send a test report between the two accounts (the game client's report menu, or `POST /player-reports/v1/report` from a script), with both accounts seated in the same room in
     your test server. Wait one poll. **Does a new report appear in the hub, with the message as the note and the reason you mapped?** Then try a report where one player is not seated: the log
     should show `chatwarden.eos_report_skipped` with `unseated` and the hub should show nothing.
  7. Batch size and limits: set `reports.batch` to 20, then 50, then 100 and note the largest the find call accepts without a 400 (the fake accepts 50). Watch the log for `status: 429` in
     any run and note it. The EOS pages state no rate limits.
  8. Ask the maintainer to read your notes, then write the results in `docs/status.md` (K5).
- **Open: a lost revoke.** If the kit restarts between a revoke and the EOS delete, the EOS sanction stays until it ends by itself. A sweep that finds `active` links whose group was revoked
  and deletes them is not built (design section 13).
- **Open: pulling sanctions made in the EOS Developer Portal into the kit (`GET /sanctions/v1/sync`), EOS appeals and EOS anti-cheat.** Not built, on purpose (design section 13).
- **Open: the lookup reads at most 500 sanctions of one user.** A user with more, where ours is not among them, gets no push and a `reconcile` log. If a real player has that many, page further.
