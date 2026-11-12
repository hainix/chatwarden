# chatwarden.dev: copy and demo rewrite proposal

Date: 2026-11-11. Sources: the live site at 1440 and 390 wide (screenshots in this folder: `hero-*`, `demo-*`, `full-*`), the demo played end to end (report, take the case, decide, see Bo's notice), `site/src` (content.ts, sections/, demo/), index.html, public/llms.txt, and the product docs (README.md, hub-react, player-react, http, matcher and profanity READMEs, docs/status.md).

Nothing in the repo was changed.

---

## 0. Two facts the copy has to respect (read first)

1. **Chatwarden does not give a game chat.** It moderates the chat a game already has. There is no chat transport and no chat-box component: the server calls `cw.chat.accept(...)` on each line, and player-react ships notices, a report dialog, the player's record, the rules and a "chat is off" line. It has no chat window. So the owner's line "quickly adding chat along with moderation" can't be copy yet. The page says "moderation for the chat you have" (see open question 1).
2. **The licence is Apache-2.0, not MIT.** LICENSE, every package.json and the site all say Apache-2.0. The brief says MIT. The copy below says Apache-2.0 (open question 2).

Other limits the copy must not paper over:
- **Slur blocking needs your own word list.** The matcher ships only invented test words (`zorbak`); no shared list exists yet. The profanity package has a built-in English swear list.
- Spaced-out letters (`z o r b a k`) are not caught, on purpose.
- The server side is Node 22.13 or newer only. There is no HTTP route for checking a chat line, so a non-Node game server has no ready path.
- Storage is a SQLite file (or in-memory for tests). There is no Postgres or other store.
- AI levels 1 to 4 are not built. Only "off" exists.
- It is pre-release (0.1.x), provided as-is, with no support promise.

---

## 1. Diagnosis: why it reads as AI slop

**It never says what you get.** The hero lists three abstract qualities and never mentions the moderator hub, which is half the product:
> "It refuses slurs that dodge simple filters, keeps the evidence when players report, and lets trash talk be trash talk."

"Refuses" is the API's word (`refuse`), not a player's or a developer's. "Give it a warden" is a pun on the brand and tells you nothing.

**Templated filler lines.** These sentences could sit on any product page:
> "Everything a small team needs between "someone said something awful" and "it's handled"."
> "Made for indie developers and the coding agents that help them."
> "Use it, change it, ship it. Keep the licence notice."

**Internal jargon used before it is explained.** Simple mode, workbench, case, ladder, steps, staff routes, headless, pieces, seats, preset, profile, identify, Community Rule, levels and ceilings all appear with no definition. The worst offender is the hub card:
> "A team workbench for moderators, with a Simple mode of one card per case. Editable steps and reporting: set the timeout lengths, the ladder and how players report (one tap by default). Four ways to adopt it: a drop-in, pieces, hooks and headless, or one script tag (<chatwarden-hub>)."

Some more:
- "A fair ladder", which is never said to mean warning, then timeouts, then a ban.
- "Copy it, then point identify at your own connections."
- The pane tag "the real hub, over the real staff routes".
- "The kit reads the raw body itself." (in "Works with").

**The tour narrates implementation and housekeeping instead of telling you what to do:**
> "The hub never moves the list under your cursor, so a new case waits behind a "1 new case" pill. Close the thank-you if it is open, then press the pill."
> "The dialog is one step: pick a reason if you like, then press Report once. The thank-you can wait."
> "Press More, then Steps and ladder (in Detailed it is under Settings). The 1, 6 and 12 hour lengths moderators can pick are set there, and an owner can edit them."

The game chat right next to it moves under your cursor every few seconds, which makes the first of those lines read as ironic.

**The biggest section is about something that doesn't exist.** "AI moderation levels" has five numbered rows (four marked "Coming soon"), a progress meter ("AI levels shipped: 0 of 4. Level 0 is live", and level 0 is "Off") and a "Hard limits we're building in" box with five rules for a feature that isn't built. A visitor's lasting impression is "mostly vapourware".

**Repetition and hedging:**
- "Pre-release / as-is / no SLA / no support promise" appears four times: Open source, FAQ, footer and noscript.
- Discord appears in both Features and Works with.
- "Slurs that dodge simple filters" appears in the hero, Features and every meta tag.
- The FAQ's free answer opens with "There is no SLA and no support promise".

**Mixed words for one thing.** A blocked line is "Refused!" on the stamp, "Blocked" in the notice, "restricted" in the API and "timed out" on the seat chip. The player's dialog says "Your chat is turned off". A report is also a "case", and a player is a "person", a "seat" or a "subject".

**The FAQ answers questions nobody asks first:**
- "Does it catch spaced or hyphenated letters?"
- "Can my coding agent set it up?"
- "Is it really free?"

Meanwhile it skips the ones every developer asks:
- Does this give me chat?
- Does it work with my server?
- Which words does it block?
- How do my moderators log in?
- Where's my data?

**Sections that don't earn their place:**
- "Works with" repeats Features and the Steps.
- "Built in the open" is a licence badge plus three npm links.
- The trailing "Want routes for moderators and players? Add @chatwarden/http…" contradicts the hub step just above it, which already needed @chatwarden/http.

---

## 2. The page's one job, and its structure

**Visitor:** a game developer who has in-game chat, or is about to add it.

**They leave knowing three things:**
1. You can put moderation on your game's chat with a few lines on your server.
2. You get a moderator hub where each report is one card and one click.
3. The exact steps to wire it into the game they already have.

**Lead with Simple mode, without calling it that.** On the site, the hub *is* the one-card view: "one card per report, one click to act". "Simple" is only named inside the demo, where the visitor can see the switch. "Detailed" gets one line, as the door for bigger teams.

**Section order** (current, then proposed):

| # | Proposed section | Replaces | Why |
|---|---|---|---|
| 1 | Header: Demo · How it works · Add it · FAQ · GitHub | adds "How it works", drops "Features" and "AI levels" | nav matches the page |
| 2 | Hero | Hero | says what you get, including the hub |
| 3 | Try it (demo) | Play both sides | proof right after the promise |
| 4 | How it works: three panels (In the chat / In your game / In your hub) plus one "Your rules" strip | What you get (6 cards) + Works with (4 tiles) | defines every term once, in plain words |
| 5 | Add it to your game: 4 steps + 1 optional | Add it in 3 steps + hub step + http footnote | the hub becomes a numbered step, not an afterthought |
| 6 | Free and open source: one band | Built in the open | one honest paragraph, said once |
| 7 | FAQ: 9 questions | Questions (7) | the questions developers actually ask |
| 8 | Footer | Footer | |
| | **Cut:** AI moderation levels | | one FAQ line covers it (open question 4) |
| | **Cut:** Works with | | merged into How it works and the FAQ |

**Glossary rule.** Each term is explained on first use, or avoided.

| Term | Rule on the page |
|---|---|
| hub | Always "moderator hub" on first use, then "the hub". Defined in the hero subhead ("a web page where your team handles reports"). |
| Simple / Detailed | Not on the page outside the demo. In the demo: "the hub's default view: one card per report". |
| case | Use "report" on the site. The demo can say "case" only where the hub's own UI says it (the "1 new case" pill). |
| ladder | Never. Say "a warning, then timeouts, then a ban". |
| preset / profile | "Rules: relaxed, standard or strict". |
| refuse / refused | Never. Say "block / blocked". |
| levels / ceilings / rule gaps / staff routes / headless / seats / identify | Never on the page. |

---

## 3. The rewritten copy

House style: short declarative sentences, second person, concrete nouns, no "seamless/powerful/effortless", no rhetorical pairs. "Your game", "your moderators", "players".

### 3.1 Meta (index.html, og:, twitter:)

- **title:** `Chatwarden: chat moderation for games, with a moderator hub`
- **description (155 chars max):** `Block slurs, let players report in one tap, and handle every report from a moderator hub. Free, open-source packages for your Node game server.`
- **og:title / twitter:title:** `Chatwarden: chat moderation for games`
- **og:description / twitter:description:** `A word filter, in-game reporting and a moderator hub for the chat your game already has. Free and open source.`
- **og:image:alt:** `Chatwarden: a chat message marked Blocked, next to a moderator's report card.` (Matches the hero visual if that changes; otherwise keep the current alt but say "Blocked", not "REFUSED".)
- **noscript:** `Chatwarden is free, open-source chat moderation for games. It blocks slurs before they're posted, lets players report a message in one tap, and gives your team a moderator hub to handle each report in one click. It runs on your own Node server. The live demo needs JavaScript. Read the code on GitHub or install it from npm.`

### 3.2 Header

Nav: `Demo` · `How it works` · `Add it` · `FAQ` · `GitHub`

### 3.3 Hero

- **Headline (H1):** `Chat moderation for your game. Moderator hub included.`
  - Line split for the display font: "Chat moderation / for your game. / Moderator hub / included."
  - Alternatives are in open question 3.
- **Subhead:** `Chatwarden blocks slurs before they're posted, lets players report a message in one tap, and gives your team a moderator hub: one card per report, one click to act. Add it to the chat you already have with a few lines on your Node server.`
- **Primary CTA:** `Try the live demo` → #demo
- **Secondary CTA (ghost button):** `Add it to your game` → #add-it
- **Proof line under the buttons:** `Free · Open source (Apache-2.0) · Runs on your server, no account`
- The install command moves out of the hero into step 1. It currently wraps to two lines at 1440 wide and three at 390, and a command is a weak second CTA.

**Hero chat mock:**
- Tag `standard preset` → `standard rules`.
- Stamp `Refused!` → `Blocked`.
- System line `Blocked. Only Bo sees this notice.` → `Blocked. Only Bo sees this.`
- Replay button: keep.

### 3.4 Demo section (#demo)

- **H2:** `Try it: you're the player and the moderator`
- **Lead:** `On the left, a game lobby. On the right, the moderator hub your team would use. Report a message, then deal with it. It takes about a minute, and it all runs in your browser.`

**Toolbar:**
- `Reset demo` → `Start over`
- `Pause chat` / `Resume chat`: moves into the game pane header (section 4, fix F).
- `Show me the code` → `Show the code`
- `Restart tour` → `Restart the tour`

**Under the panes** (moved from above them):
- Badge `This is the real Chatwarden kit running in your browser, with a made-up word list.` → `The real packages, running in your browser. The blocked words are made up, like "zorbak".`
- Disclosure `What is different here` → `Demo settings`. Body: `Swearing is allowed. Bo's notice opens here so you can see his screen. You're signed in as the owner, so every page of the hub is open. Everything else is the default.`

**Game pane:**
- Heading `The game` → `Your game`; tag `#lobby`.
- Seats note `Ada and Bo are scripted. Only you type.` → `Ada and Bo are bots. You can type too.`
- Chips: `gg` · `nice one` · `Try a blocked word`
- Placeholder `Say something` → `Type a message`
- Report button: `Report` (keep). aria-label `Report Bo's message: "…"`.
- Blocked line system note `Blocked by Community Rule 1. Only you see this.` → `Blocked (rule 1). Only you can see this.`
- Notice bar `Bo has a notice waiting.` + `See what Bo sees` → `Bo has a notice.` + `See Bo's screen`
- Quiet note → `Bo is timed out for 7 days, so he's gone quiet. Press Start over to replay.`
- Refusal messages (notice.ts): replace "Press Reset demo to start over" with "Press Start over to replay." The rest are fine.

**Moderator pane:**
- Heading `Your moderator` → `Moderator hub`
- Tag `the real hub, over the real staff routes` → `what your team sees`
- Loading `Opening the moderator hub…` → `Loading the hub…`

**Placeholder and errors (DemoSlot.tsx):**
- Placeholder pane names: `Your game` / `Moderator hub`.
- Load failure: `The demo didn't load. Reload the page, or skip to the setup steps.`
- Demo error: `Something went wrong in the demo. Press Start over.`

**Guided tour: 4 steps instead of 7.** The two optional steps (Detailed switch, Steps and ladder) are cut, and "case appears" and "open it" are merged into one step.

| # | Title (also the phone bar's text) | Body |
|---|---|---|
| 1 | `Report Bo's message` | `Bo's being rude. Press Report next to his highlighted message, choose "Insults or harassment", then press Report.` |
| 2 | `Open the report in the hub` | `It just reached your moderator hub, with the chat around it as evidence. Press "1 new case", then open Bo's report.` |
| 3 | `Take the suggested action` | `This is the hub's default view: one card per report. It shows what Bo said, his history, and the action your rules suggest. Press the suggested action. You have five seconds to undo.` |
| 4 | `See what Bo sees` | `Bo gets a plain notice: what he did, which rule, and for how long. Press See Bo's screen.` |
| Done | `That's the whole loop` | `A player reported, you decided in one click, and Bo was told why. That's what you add to your game.` Buttons: `Add it to your game` (→ #add-it, primary) · `Play again` · `Close` |

Why step 1 says to choose "Insults or harassment": that reason maps to exactly one rule (rule 2, in core `reporting.ts`), so the card pre-selects the rule and shows the suggestion straight away. With no reason, the card first asks "Which rule does this break?", and that detour is where visitors stall today. I recorded it on the live site: with no reason picked, the card asked for a rule, and choosing rule 1 suggested a 7-day restriction for an insult.

Hints:
- **Rule picker fallback** (if they skipped the reason): `Pick the rule this breaks. The hub then suggests an action.`
- **NO_NOTICE_HINT:** `You chose no action, so Bo isn't told anything. Report another message and take the suggested action to see his notice.`
- **NO_REPORT_HINT:** `Nothing to handle yet. Report one of Bo's messages first.`

Tour card buttons: `Show the code` · `Skip tour` · `Next`.

**Code drawer blurbs** (codeSteps.ts, one sentence each; the code stays verbatim from the READMEs):
1. `Your server files the report with one call. The room and players come from your session, never from the client.`
2. `The whole hub is one component on a page of your admin site.`
3. `A decision closes the report, applies the timeout and writes the player's notice in one step.`
4. `Your game reads the player's notices from one route and shows them with the notice dialog.`

### 3.5 How it works (#how)

- **H2:** `How it works`
- **Lead:** `Your game keeps its own chat. Chatwarden checks each message, collects reports, and gives your team one place to act on them.`

**Panel 1: In the chat**
> Every message goes through one check before your server sends it. Slurs on your word list are blocked, even written with leetspeak, look-alike letters, accents or repeated letters. Ordinary swearing is your call: allow it, star it out, or block it. Trash talk stays. The sender sees why their message was blocked, and nobody else sees it.

**Panel 2: In your game**
> Players report a message in one tap. The report carries the chat around it, so your moderators see what happened, not just a complaint. When a moderator acts, the player gets a plain notice: what they did, which rule, and for how long. Ready-made React components cover the report dialog, notices, the player's record and your rules.

**Panel 3: In your moderator hub**
> The moderator hub is a web page where your team handles reports. Each report is one card: what was said, the player's history, and the action your rules suggest. One click to act, five seconds to undo. Repeat offenders go from a warning to timeouts to a ban.
> *Bigger team? Switch to the Detailed view for a full queue with filters and claims, so two moderators never take the same report. Prefer Discord? Each reported player can get a thread in a Discord forum.*

**Strip: Your rules**
> Start with relaxed, standard or strict rules. They set what counts as over the line, what the hub suggests, and the code of conduct your players read. Change any of it later in the hub.

### 3.6 Add it to your game (#add-it)

- **H2:** `Add it to your game`
- **Lead:** `Chatwarden needs three things from your server: who's talking, each message before it's sent, and a page for your moderators. It runs on Node 22.13 or newer, with any framework.`

| Step | Title | Body | Code (verbatim from a README; see the implementation notes) |
|---|---|---|---|
| 1 | `Install` | `The engine, its storage (one SQLite file, using the SQLite built into Node) and the word filter.` | `npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher` |
| 2 | `Set it up once` | `Tell it how to recognise a player: your login token and their IP address, both hashed before anything is stored. Load your word list and pick relaxed, standard or strict.` | the engine setup, shortened (see the notes) |
| 3 | `Check every message` | `Call it before you broadcast a message. It answers deliver, or block with a reason you show only to the sender.` | the `cw.chat.accept` block (current STEP_CHAT) |
| 4 | `Add the moderator hub` | `Mount the moderator routes behind your own login: you write one function that says who's a moderator. Then put the hub on a page. In React it's one component; anywhere else it's one script tag.` | tabs: **React** (`<Hub client={client} />` with its install line) · **Any page** (`<chatwarden-hub base-url="/admin">`) · **Server** (the `app.use('/admin', toExpress(adminRoutes(cw, { authorize })))` lines from the root README Quick start) |
| 5 (optional) | `Show players what happened` | `Add the report dialog, notices and the player's record from @chatwarden/player-react.` | link only |

Closing line: `Every package has a README with the full setup, options and security notes. For a complete chat server wired up end to end, see examples/tiny-chat in the repo.`

Delete the trailing "Want routes for moderators and players? Add @chatwarden/http…" paragraph, since step 4 now covers it.

### 3.7 Free and open source (#open)

- **H2:** `Free, open source, and yours to run`
- **Body:** `Apache-2.0, with no paid tier and nothing hosted. It runs on your server and keeps its data in your database file. Chatwarden is pre-release (version 0.1): ready to try, with no support promise yet. Issues and pull requests are welcome.`
- **Buttons:** `View on GitHub` · `Packages on npm`
- **Small line:** `Published to npm with provenance.`
- Cut the "Use it, change it, ship it" line and the three npm package chips; GitHub and npm already lead there.
- "Built for Moxgate, now being adopted" is cut (open question 8).

### 3.8 FAQ (#faq)

H2: `Questions`

1. **Does Chatwarden give my game a chat?**
   No. It moderates the chat you already have. Your server still sends the messages; it asks Chatwarden first.
2. **Will it work with my game server?**
   If your server runs Node 22.13 or newer, yes, with any framework: the check is one function call. The moderator routes come with an Express adapter, and work with any other framework through a small router. If your server is written in another language, there's no ready-made bridge yet.
3. **Which words does it block?**
   Slurs from a word list you provide. There's no shared list yet, so you bring your own, and moderators can edit it from the hub while the game runs. Ordinary swearing uses a built-in English list that you can allow, star or block. Words with spaces between the letters are not caught, on purpose, because that would block innocent messages. Players can report those.
4. **How do my moderators sign in?**
   With the login you already have. You write one function that reads the request and says who the moderator is and their role. Chatwarden never sees a password.
5. **Where is player data stored?**
   In a SQLite file on your server. Player IDs and IP addresses are hashed with a secret only you hold. Chatwarden runs no servers and collects nothing, and this site has no analytics.
6. **What does it cost?**
   Nothing. It's open source under Apache-2.0, with no paid tier.
7. **Does it use AI?**
   No. Optional AI help that sorts reports and drafts decisions is planned, with a person always deciding. It isn't built yet.
8. **Can reports go to Discord?**
   Yes. Each reported player gets a thread in a Discord forum, with a link back to the hub.
9. **Is it a child-safety tool?**
   No. For detecting and reporting child sexual abuse material, use Coop and HMA. *(links kept)*

Cut "Does it catch spaced or hyphenated letters?" (folded into Q3) and "Can my coding agent set it up?" (llms.txt and AGENTS.md already serve agents).

### 3.9 Footer

- **Brand line:** `Chat moderation for games. Free and open source.`
- **Links:** `GitHub` · `npm` · `Report an issue` · `Licence`
- **Fine print:** `Apache-2.0. Pre-release, provided as is. Not a child-safety tool.`

### 3.10 llms.txt summary line

`> Chatwarden is free, open-source chat moderation for games: a check for every chat message (slurs from your word list, optional swearing filter), in-game reporting with evidence, player notices, and a moderator hub (one card per report by default). TypeScript for Node 22.13 or newer. Pre-release (0.1.x), Apache-2.0, provided as-is. It moderates an existing chat; it is not a chat system. Not a child-safety tool.`

The package list below it can stay. Change "Simple mode of one card per case" to "one card per report by default".

### Implementation notes for whoever builds this

- `test/content.test.ts`, `meta.test.ts`, `sections.test.tsx`, `demoTour.test.tsx` and `finalReview.test.ts` lock today's copy. Each copy change starts as a failing test, per the owner's test-first rule.
- Every code block must stay verbatim from a README; `content.test.ts` and `demoCode.test.ts` check this. To shorten step 2:
  - either add a short "minimal setup" block to the core README and quote it,
  - or quote the root README Quick start's `createChatwarden({ store: openStore(...), secret, platform, matcher, profile: 'standard' })` line, plus the `identify` block, collapsed behind "Show the full file".
- The `harassment` → rule 2 mapping that tour step 1 relies on is in `packages/core/src/reporting.ts:115`. Assert it in a demo test so the tour doesn't break silently.
- **Visible strings must match the tour copy.** The tour points at hub controls by their visible names (hubTarget.ts). Tour copy must use the hub's own words ("1 new case", the step button names) and the game pane's new labels ("See Bo's screen"). `findTarget` and `data-tour` hooks must follow any label change.

---

## 4. The demo's moving click targets

### What I measured on the live site (Playwright)

- **A parked pointer loses the Report button within 3 seconds.** I parked the pointer on Bo's "Report" button and held still. At 1440 wide: 3 s later the pointer was over the bubble, 8 s later over empty chat, 13 s later over a different message. At 390 wide: the same at 3 s, then 7 s later over Ada's "rematch?".
- **The tour target and its card move on their own.** With no input, the highlighted Report button and the tour card moved every 4 to 6 s: y = 477 → 394 → 282 → 198 px. At 16 s they jumped to a different message (y = 477) as a newer rude line from Bo arrived.
- **Taking an action reshapes the game pane.**
  - The notice bar and a two-line "timed out" note appear, shrinking the chat.
  - The tour card covers the chat in step 2 (`demo-hub-pill-1440.png`) and the composer chips and the hub's "Decision sent" toast in step 5 (`demo-decided-1440.png`).
- **At 1440×900 the demo doesn't fit on screen.** When you land on #demo, the composer and the tour card are below the fold (`demo-1440.png`), so people scroll the page and the chat at the same time.

### Causes, by mechanism

| # | Cause | Where |
|---|---|---|
| C1 | **Unconditional stick-to-bottom.** `useLayoutEffect(() => { el.scrollTop = el.scrollHeight }, [feed])` runs on every new line, whether or not the reader is at the bottom, hovering, or reading older lines. Each line scrolls the chat 85 to 140 px. | `Demo.tsx` ~308-312 |
| C2 | **A chat that never stops.** A new line every 4 to 6 s, looping forever. It pauses only for: the Pause button, an open dialog, a non-empty focused input, or a hidden tab. It does *not* pause when the pointer is over the chat, focus is on a Report button, or the demo is off screen. It starts as soon as the chunk loads (200 px before the section scrolls into view). | `Demo.tsx` ~272-306 (`tick`), `DemoSlot.tsx` rootMargin |
| C3 | **The tour target is re-picked on every render.** `tourLineId` is "the newest rude line from Bo", so the ring and the card jump to each new rude line (LOOP items 4, 8 and onwards). | `Demo.tsx` ~352-356 |
| C4 | **The tour card follows everything.** It is re-positioned after every render, on every scroll inside the demo (`host.addEventListener('scroll', again, true)`, which fires on each chat auto-scroll) and on every hub DOM change (MutationObserver → `hubTick`, and the hub polls every 5 s). It animates with `transition: left .28s, top .28s`. It is placed beside the target, so it covers other content. | `Demo.tsx` ~331-345, 443-536; `demo.css` `.tour` |
| C5 | **The Report button is hidden and floats.** It has `opacity: 0` until the line is hovered, so on desktop the target only appears once the pointer reaches it. It sits in a flex row after a bubble of variable width, so each line's Report has a different x. Narrow 340 px panes wrap bubbles to 2 or 3 lines, which makes lines tall and every scroll step bigger. | `demo.css` `.report-btn`, `.msg-main`; 1152px+ grid `minmax(300px, 340px)` |
| C6 | **Content inserted inside a fixed-height pane.** The game pane is a fixed 660 px, so anything added shrinks the chat and shifts its lines: the NoticeBar between chat and composer (with a `translateY(36px)` entrance), `seats-note` growing to two lines, the `seat-flag` chip, and `composer-note`. | `GamePane.tsx` NoticeBar/seats; `demo.css` `.notice-bar`, `frame-in` |
| C7 | **Entrance motion on every line.** `msg-in` animates `translateY(14px) scale(.97)` with an overshoot curve, every 4 to 6 s. | `styles.css` `.msg`, `@keyframes msg-in` |
| C8 | **Phone: the page scrolls itself.** On each tour step the demo switches panes (`setPaneTab`), calls `scrollIntoView` on the target, then re-scrolls 650 ms later. The compact bar shows only the step title; the instruction is hidden behind a tap. | `Demo.tsx` ~366-421, 456-467; `TourCard.tsx` compact |
| C9 | **Feed trimming.** `FEED_MAX = 60` drops lines from the top after about 5 minutes, which jumps a reader who has scrolled up. | `Demo.tsx` `FEED_MAX`, `play`/`send` |

### Fixes, in priority order

**A. Make the scripted chat finite and reactive** (`script.ts`, `Demo.tsx` tick loop). Fixes C2 and C3 at the root.
- The seed conversation plays once, ending on Bo's rude line, then the room goes quiet. There is no endless LOOP.
- Ada and Bo answer only in response to something:
  - one reply 2 s after the visitor sends a message;
  - after a decision, Ada says "thanks mods" and Bo, if timed out, is silent.
- Keep the LOOP behind a `scripted="loop"` prop for tests if one is needed. The idle soak test in `kitReal.test.ts` changes to match.

**B. If any timed lines remain, gate them hard** (`Demo.tsx`):
- Add a `hold` flag in `live.current`, set by `pointerenter`/`pointerleave` and `focusin`/`focusout` on `[data-pane="game"]`. Also hold while a Report button is hovered or focused, while any dialog is open, and while the tour is on step 1.
- Start the loop only when the demo is at least 50 % in view (an IntersectionObserver on the demo root, threshold 0.5), and stop it when the demo leaves view.
- When the hold lifts, wait 1.5 s before the next line.

**C. Scroll only when the reader is at the bottom** (`Demo.tsx` useLayoutEffect; `GamePane.tsx`):
- Keep `atBottom` in a ref, updated by the chat's `scroll` handler (`scrollHeight - scrollTop - clientHeight < 24`), and auto-scroll only if it is true and the pointer is not in the chat.
- Otherwise show a `↓ 2 new messages` pill pinned to the chat's bottom edge that scrolls on click. This is the same rule the hub already follows with "1 new case", so the demo practises what the tour preaches.
- Trim the feed (C9) only while `atBottom`.

**D. A fixed, always-visible Report button** (`GamePane.tsx` Message, `demo.css`):
- Make `.msg` a three-column grid, `34px minmax(0,1fr) auto`, with Report in its own right-hand column. Every line's Report then lines up at the same x.
- Show it at all times: muted at rest, full colour on hover or focus. Drop `opacity: 0`. Reserve its width so hovering never reflows.
- Widen the game pane to `minmax(360px, 400px)` so bubbles wrap less.

**E. Freeze the tour target** (`Demo.tsx` `tourLineId`): when step 1 starts, pick Bo's rude line once, store its id in state, and keep it until it is reported or leaves the feed. With fix A the line never leaves.

**F. Dock the tour; don't float it** (`TourCard.tsx`, `Demo.tsx` positioning effect, `demo.css .tour`):
- **Desktop:** the tour becomes a fixed strip above the panes ("Step 2 of 4 · Open the report in the hub", body, Next/Skip). The gold ring on the target stays, but the card no longer follows it.
  - This deletes the per-render `getBoundingClientRect` placement, the scroll/resize/MutationObserver re-positioning and the `left/top` transition (C4).
  - The card can no longer cover chat, chips or hub toasts.
- **Phone:** keep the bottom bar, but its text is the instruction (the step title is now an imperative, see 3.4), not a label you have to tap open.
- Move the Pause control from the page toolbar into the game pane header, next to `#lobby`: `⏸ Pause` / `▶ Resume`. When fix B is holding the chat, show `Paused while you read` there.

**G. Reserve space instead of inserting it** (`GamePane.tsx`, `demo.css`):
- Give the area between the chat and the composer a fixed slot (min-height 0, overlaying the chat's bottom edge as a toast-style bar), so the notice bar doesn't resize the chat. Drop the `translateY(36px)` entrance; use opacity only.
- Clamp `seats-note` to one line, and put the "timed out for 7 days" explanation in the notice bar.
- Show `composer-note` as an overlay above the input rather than a new row.

**H. Phone: no automatic page scrolling** (`Demo.tsx` ~366-421, 456-467):
- Don't switch panes or call `scrollIntoView` when a step changes. Instead the tour says "Open the Moderator tab", and the tab pulses with its badge, which already exists.
- Keep the focus-on-heading logic only for an explicit tab press.
- Remove the 650 ms re-scroll.

**I. Calmer motion** (`styles.css`): new chat lines get a 120 ms opacity fade with no translate or scale, and none at all under `prefers-reduced-motion`. Keep the stamp slam for the hero and for the visitor's own blocked line: that motion is the point.

**J. Make the demo fit the viewport** (`Demo.tsx` markup, `demo.css`):
- Move the badge and "Demo settings" below the panes.
- Make pane height `min(660px, calc(100vh - 64px header - 56px tour strip - 32px))`, so landing on #demo shows the whole demo at 1440×900.

---

## 5. Visual and design issues noticed in passing (ranked)

1. **The demo doesn't fit a 900 px-tall viewport** (fix J). It is the conversion moment and half of it is below the fold.
2. **The game pane is too narrow** (340 px). Bubbles wrap to 2 or 3 lines and the Report pills float at ragged positions (fix D).
3. **The AI levels section is the heaviest block on the page**: 5 dashed cards, a meter and a sidebar, all for "Coming soon". Cutting it shortens the page by about 15 %.
4. **The Steps code is a wall.** Step 2 is about 33 lines at full height on the page. Show 8 to 10 lines with "Show full file", and use tabs for the React / script-tag / server variants of step 4.
5. **The hero mock shows the filter and nothing of the hub.** After its animation it is mostly empty dark panel (`hero-1440.png`). A better hero visual: two frames, a chat line with a "Report" tap, then the one-card hub view with "Restrict chat, 24 hours". That makes the product's two halves visible before anyone reads.
6. **Feature cards are uneven.** The hub card has twice the text of the others. The proposed three panels with similar lengths fix this.
7. **The hub's light theme inside the dark "screen" frames** looks like a pasted-in screenshot. Consider giving the hub its dark theme inside the demo regardless of the site theme, or framing the hub pane light.
8. **The hub shows two Undo controls at once**: the inline card and the bottom toast (`demo-undo-1440.png`). This is a hub-react issue, not site copy.
9. **The hub's own suggestion text is jargon**: "Standard profile: severe conduct is acted on at once, never below the first-offense outcome or the ladder step for the record: restrict chat 7 days." This is hub-react's `en` catalogue, and is worth the same rewrite pass, since visitors read it in the demo.
10. **The phone tour bar shows a label, not an instruction**: "The case appears in the hub" (`demo-390-step2.png`). Fixed by the imperative titles in 3.4.

---

## 6. Open questions for the owner

1. **"Add chat to your game": should we build a chat box?** Today Chatwarden moderates an existing chat and ships no chat transport or chat UI.
   *Recommendation:* the copy says "moderation for the chat you already have" (as written above). If you want the "add chat" promise, that's a product item: a `<ChatBox>` in player-react plus a small room broadcaster in http. The headline changes only after it ships.
2. **Licence: MIT or Apache-2.0?** Your brief says MIT; the repo, npm and site say Apache-2.0.
   *Recommendation:* keep Apache-2.0 on the page, because it's the truth. Relicensing is a separate decision.
3. **Headline.**
   - (a) `Chat moderation for your game. Moderator hub included.`
   - (b) keep `Your game has chat. Give it a warden.`, with the new subhead
   - (c) `Moderate your game's chat in one click.`

   *Recommendation:* (a). It names both halves of the product. (b) is charming but says nothing a newcomer can use.
4. **The AI levels section.** Cut it entirely, or keep it as one "Coming" line on the page?
   *Recommendation:* cut the section, and keep the single FAQ answer ("No. … It isn't built yet."). Bring it back as a section when level 1 ships.
5. **"In minutes".** Can we promise a time?
   *Recommendation:* no time claim for now. Say "a few lines on your server". Someone should time a fresh install against `examples/tiny-chat`; if it's under 15 minutes, add "in about 15 minutes" to the Add it lead.
6. **Scripted chat.** Finite and reactive (fix A), or a looping chat with hold-on-hover (fix B)?
   *Recommendation:* fix A. It removes the moving targets at the source and makes the demo feel like a calm product, not a screensaver. Fix B is only a fallback.
7. **Tour length.** Cut from 7 steps to 4, dropping the Detailed-switch and Steps-and-ladder steps?
   *Recommendation:* yes. Mention Detailed in one line under "How it works".
8. **The Moxgate mention** ("Built for Moxgate, now being adopted").
   *Recommendation:* cut it until the Moxgate adoption (K6b-d) ships, then return as "Used in Moxgate" with a link and a screenshot.
9. **The non-Node FAQ answer.** Is it OK to say plainly that there's no ready-made bridge for other server languages?
   *Recommendation:* yes. It saves a frustrated install, and a chat-check HTTP route could be a small roadmap item.
10. **Telling visitors to pick "Insults or harassment" in tour step 1**, so the hub card skips the rule picker.
    *Recommendation:* yes. It's one click inside a dialog they're already in, and it removes the step where people stall.
11. **The hero visual.** Replace the chat-only mock with a chat → hub-card two-frame visual?
    *Recommendation:* yes, as a follow-up after the copy lands; it isn't needed for the copy to work.
12. **The name "Simple".** The site avoids it, but the hub's own switch says Simple / Detailed.
    *Recommendation:* keep the hub's labels. The tour introduces the view as "the hub's default view: one card per report" and never asks the visitor to learn the word.

## 7. Rulings (2026-11-11, controller, under the owner's "continue autonomous until you finish the entire chatwarden roadmap")

All twelve recommendations are accepted:
1. The copy says "moderation for the chat you already have". A `<ChatBox>` (player-react) plus a room broadcaster (http) goes on the roadmap, because the owner asked for "adding chat along with moderation into your game". The headline changes to promise chat only once it ships.
2. Apache-2.0 stays (the truth).
3. Headline (a): "Chat moderation for your game. Moderator hub included."
4. Cut the AI levels section, keeping the one FAQ answer. It comes back as a section when level 1 ships (the AI levels 1-2 work is in progress on branch ai-levels).
5. No time claim yet.
6. Fix A: the scripted chat is finite and reactive.
7. A 4-step tour.
8. Cut the Moxgate mention until K6 ships in Moxgate.
9. The non-Node FAQ answer is plain.
10. Tour step 1 suggests "Insults or harassment".
11. The two-frame hero visual is a follow-up.
12. Keep the hub's Simple/Detailed labels; the tour explains the default view.
