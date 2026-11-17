---
status: proposal (audit of main = 0.1.14; no product code)
updated: 2026-11-17
---

# Moderation coverage audit: what a game's chat moderators face, and what Chatwarden does about it

This is a gap analysis, not a plan to build everything. It lists the situations that come up in game chat and in moderating it, says
for each what Chatwarden 0.1.14 does today (read from the package READMEs, `docs/status.md`, `docs/plans/follow-ups.md` and the design
notes, and checked against the code where a README was unclear), and proposes the smallest changes that close the gaps that matter,
grouped into releases after 0.1.15.

Two things are treated as **planned and not re-designed here**: 0.1.15's offensive names inside reports and its "what the player sees"
preview on every hub action. Where a row depends on them it says "0.1.15".

Standing rules this audit keeps: the UI stays clean at the core and power sits behind one "advanced" door (Settings > Advanced, a `...`
menu); nothing new is always visible unless it only appears when there is something to act on; every new switch is off until an owner
turns it on; a person decides, and a signal or a filter never writes a sanction by itself; the kit holds hashes and ids, not people.

## 1. How to read the status

| Status | Meaning |
| --- | --- |
| **Covered** | Works today, shipped, with a screen or an API an adopter can use. Small leftovers are named in the Where column. |
| **Partly** | A real piece exists, but a common version of the situation is not handled, or it needs the adopter to build the rest. |
| **Not covered** | Nothing in the kit addresses it (a report reason that only names it does not count as covered). |
| **Out of scope** | Deliberately not the kit's job. The reason is in section 6 (what the kit must not do) or section 7 (what belongs to the game). |

Priority for gaps: **P1** common and hurts adopters now; **P2** common but there is a workaround; **P3** rare or niche.

## 2. The situations and where Chatwarden stands

Package names are `@chatwarden/...`. "Hub" is `hub-react` (and `hub-element`); "player" is `player-react`. "0.1.x" is the release that
shipped the feature.

### 2.1 What players say

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| C1 | Slurs and hate speech (English, Spanish, Portuguese, Latin script) | Covered | `matcher` (whole-word terms, `LiveTerms` editing with an innocent-lines dry run, exceptions), community term list (0.1.11, opt-in, en/es/pt), `core` strikes and automatic chat timeouts citing rule 1, hub Terms and Blocked screens, report reason `hate`, AI read. Other scripts and languages: see P4. |
| C2 | Ordinary swearing | Covered | `profanity` (allow, star, refuse; styles; custom lists), set by the profile. |
| C3 | Insults, trash talk, harassment, hostile behaviour | Covered | Conduct levels (banter, rude, hostile, severe), profiles relaxed/standard/strict, ladder with first-offence and repeat rules, reasons `harassment`, notes, AI read (levels 1 and 2). |
| C4 | Dogpiling: many players pile onto one target | Partly | Each aggressor is one case; the hub groups by reported person, and mute lets the victim silence one player. Nothing links "many people, one victim", nothing shows the victim's side, and a victim has no one-step "mute all of these" (see G7, G10). |
| C5 | Threats of violence | Partly | Reason `threat` (rule 2), conduct level `severe`, AI read. No priority: a threat waits in the same oldest-first queue as spam; no hand-off to the game's own safety process (G3, G5). |
| C6 | Self-harm and suicide statements, a player in crisis | Not covered | No reason, no lane, no way to show the player help text. The kit must not diagnose; it can route and hand off (G3). |
| C7 | Sexual content in text | Covered | Reason `sexual` (rule 3), conduct levels, term list, AI read. Images are out of scope (S9). |
| C8 | Grooming and adult-to-minor contact | Not covered | The kit has no age model. Detection is out of scope (section 6). Mitigations a game needs (who may whisper whom, strict rules for kids' rooms, phrase-only chat) are not built (G9, G10, G11). `gate(roomId, subject)` lets a game veto a line today. |
| C9 | Doxxing, sharing phone numbers, emails, addresses | Partly | Reason `personal_info` (rule 2) on a report. No detector in chat, so a number reaches the room before anyone reports it (G1). |
| C10 | Spam, flooding, repeated lines | Covered | 0.1.8 slow mode, burst limit, repeat refusal per room and player, `flood_triggered` signal, per-room override `cw.rooms.setPace`, the report reason `spam`. Per-process state: see P1. |
| C11 | Ads, scam and phishing links, invite links | Not covered | Reason `spam` after the fact only. No link rules, no allow or deny list, no "links need an account of N days" (G1). |
| C12 | RMT, gold or account selling | Partly | Reason `spam`, and the matcher can hold any word, but a hit there is an automatic timeout under the slur rule (rule 1), which is the wrong rule. No phrase or pattern rules with their own citation (G1). |
| C13 | Impersonating staff or another player | Not covered | `cw.names.check` blocks names on the term list; nothing protects staff or game names, and no report reason says "impersonation" (G12). |
| C14 | Caps, emoji or mention floods | Not covered | The burst limit and repeat refusal catch the worst cases. No ratio rules (G1, P3 inside the filter engine). |
| C15 | Cheating, griefing, AFK, throwing | Covered (reports) | Reasons `cheating`, `griefing`, `afk` (rules 5 and 6), EOS report pull (0.1.12). Finding cheats is out of scope. A report carries chat evidence only, so a moderator has no pointer to the match or replay (G20). |

### 2.2 Names

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| N1 | Offensive player names | Covered | 0.1.9: `cw.names.check` and `POST /names/check` (term list plus profanity), blocked names kept as evidence (opt-in), "ask for a new name" (`rename.required`, no sanction), names hidden in the hub until shown. 0.1.15 adds offensive names inside reports (planned). |
| N2 | Offensive names of clans, guilds, teams, decks, pets, items | Partly | `cw.names.check(text)` works for any text, so the game can gate creation. But a report targets a player seat, a rename is asked of a person, and the hub shows no entity. A game reports the owner instead (G12). |
| N3 | Names that already exist when the kit is installed | Not covered | Parked in follow-ups (no batch scan of names the game already holds). P3, a game script over `names.check` does it. |

### 2.3 Evasion and attack patterns

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| E1 | Filter bypass: leetspeak, look-alike letters, zero-width characters, repeated letters, punctuation | Covered | `matcher` reads through all of these. |
| E2 | Spaced-out letters (`z o r b a k`) | Partly | Deliberately not read, to protect innocent text; a report catches it. A narrow opt-in pass for a short list of severe terms would close it (G21, P3). |
| E3 | Ban evasion with a new account | Partly | Subjects link across client keys and account ids; a merged person keeps their bans; `cw.doors.check` at login. IP address never links people (by design). No staff view of what links to a person, no "this new account links to a banned person" hint (G8). |
| E4 | Alts and VPN or IP rotation | Partly | A sanction can also block an IP for up to 24 hours. Rotation defeats that, and the kit does not try to detect VPNs (section 6). A new device with a new account is a new person. |
| E5 | Raids and coordinated attacks on a room | Partly | Burst limit, slow mode and a per-room override stop floods. No join-velocity alarm, no "new accounts read-only" switch, no one-step lockdown a moderator can pull (G6, G7). |
| E6 | New-account probation (no links, slow mode for the first hours) | Partly | `signals.accountAgeDays` plus `guards.newAccount` only discounts a new account's signals. Nothing restricts a new account (G7). |

### 2.4 Reports and decisions

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| R1 | A player reports another (one tap, reason, note, daily budget shown) | Covered | `core` reports, `player` `ReportDialog`, reporting settings in the hub, ten a day. |
| R2 | A report with no chat line (voice, behaviour) | Covered | A one-tap report needs no line or reason; the moderator sees the room's recent lines and decides. The voice recording itself is the game's (G20). |
| R3 | False and weaponised reports | Covered | Reporter accuracy, habitual-reporter ranking, `bad_faith` verdict with evidence note and suspension, bulk "nothing wrong here" by reporter, duplicate refusal. |
| R4 | Mass reporting and report brigades on one person | Partly | One case per reported person, the reporter's record on the case. Nothing says "14 reports in 10 minutes, 12 from accounts under 2 days old" (G7). Parked: a fan-out guard. |
| R5 | A report about a moderator, or a moderator who is also a player | Not covered | Players cannot report staff; if staff play, they are players and a colleague must decide by habit. No recusal (G19, P3). |
| R6 | Telling the reporter what happened | Covered | Minimal "we took action" notice on action only; a dismissal sends nothing. |
| D1 | Warning, chat restriction, area ban, full ban, record-only note | Covered | `core` sanction kinds, ref codes, notices, "My record". |
| D2 | Temporary and permanent; permanent needs a senior | Covered | Durations list, `sanctions.apply.ban_permanent`, custom lengths behind a profile switch. |
| D3 | Repeat offenders and an escalation ladder | Covered | Editable ladder, suggestions from the record, signals feeding the suggestion (0.1.8). |
| D4 | Shadow restrictions (a mute the player cannot see) | Out of scope | A standing non-goal: players are always told (section 6). |
| D5 | Moderator mistakes: undo and revoke | Covered | Five-second Undo, revoke with a reason, audit rows. |
| D6 | Appeals | Covered | 0.1.9 (off until turned on): one per sanction, a different moderator decides, per-rule mistake rate. Parked: appeals by reporters, an SLA clock. |
| D7 | AI help with triage | Covered | Levels 1 and 2 (0.1.7), gate dashboard (0.1.13), shadow mode (0.1.14). Acting (R3) and Watch (R4) are the owner's gate, not a gap. |
| D8 | Hold a flagged line for review before others see it | Not covered | Designed in the capability map, never built (G22, P3). |

### 2.5 Where the talking happens

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| S1 | Public rooms and lobbies | Covered | `core` rooms and seats, `chat.accept`, the chat box (0.1.6) or the game's own socket. |
| S2 | Team chat, clan or guild chat | Partly | Any channel the game routes through `accept` as a room is moderated and reportable (the buffer is per room). One profile applies to every room, so "kids' room strict, ranked room relaxed" is not possible (G9). |
| S3 | Whispers and direct messages | Partly | A two-seat room works the same way. No rule for who may message whom, no block (G10). |
| S4 | Room tools: slow mode | Covered | `cw.rooms.setPace`, hub Settings > Advanced. |
| S5 | Room tools: lock or read-only, remove a delivered line, clear, kick, room owner as moderator | Not covered | `cw.rooms.close` is the game's. The chat box has no way to retract a delivered line for everyone (G6). |
| S6 | Block (mute, and never matched or messaged again) | Not covered | Mute is per viewer and lasting; "block" is a game rule that needs a list the game can read (G10). |
| S7 | A player's own chat settings (hide swearing for me, chat off) | Partly | Mute only; starring is one setting for everyone. P3, folded into G10. |
| S8 | Voice chat | Out of scope | Text only. A voice report can still be filed with no line (R2). |
| S9 | Images, avatars, user-made content | Out of scope | Text and names only. |
| S10 | Chat the kit does not carry (Twitch, YouTube, a Discord server) | Out of scope | The kit feeds staff channels (Discord feed and bot, Coop, EOS); it does not moderate other platforms' chat. |
| S11 | Streamer and creator channels, each with its own moderators | Not covered | Staff are one team for one instance. No scoping of a moderator to a set of rooms (G9, P2 as scope; creator features such as follower-only chat are P3). |
| S12 | Phrase-only chat for young players | Not covered | Designed as "quick chat", never built. The chat box takes free text (G11). |

### 2.6 Minors, legal and privacy

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| L1 | Minors and age-appropriate settings | Not covered | No age model by design (the kit stores no more about a person than it must). Age checks and parental consent are the game's. Per-room strictness and phrase-only chat are the kit's share (G9, G11). |
| L2 | A credible threat, escalation to law enforcement | Partly | A reason and a severe level exist; no legal-hold, no hand-off marker, no evidence bundle. Judging "credible" and reporting are not the kit's job (section 6). |
| L3 | CSAM | Out of scope | The README's first line sends adopters to Coop and HMA; the Coop adapter never sets `csam`. The kit stores no images and fetches no links (section 6). |
| L4 | Keeping evidence long enough, and deleting it on time | Partly | Retention defaults (reports 90 days, audit 365) with floors. No way to hold one report past the purge when a legal process needs it (G5). |
| L5 | Evidence export for a platform, an appeal or a legal request | Not covered | Designed as a signed bundle (K12), never built. Webhooks can carry excerpts if the adopter opts in, which is not an export (G5). |
| L6 | A player asks to be erased (GDPR right to erasure) | Not covered | The sqlite README says run a database step yourself and clear `kit_claims` too. The subject and identifier tables are never purged. No `erase` (G2). |
| L7 | A player asks for their data (right of access) | Not covered | No `export` (G2). |
| L8 | Privacy by default | Covered | Keyed hashes, raw IPs and keys never stored, no chat in logs or Discord posts, signed webhooks without lines by default, appeal statements and kept names on short clocks. |
| L9 | Publishing how the game moderates | Partly | The rules page and generated code of conduct are covered (`GET /code-of-conduct`, `RulesPage`). A periodic transparency report is not (G24, P3). |

### 2.7 Moderator team

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| T1 | Roles and permissions | Covered | moderator, senior, owner, per-permission overrides, `GET /me` tells the hub. |
| T2 | Audit of who did what | Covered | `GET /audit`, every read of evidence and every setting change. Not tamper-evident (G23, P3). |
| T3 | Claiming a case, taking over, who is on it | Covered | Soft claims (10 minutes), take next, viewing hints, take over for a senior. |
| T4 | Second opinion, escalate to the owner, internal comments on a report, assignment | Not covered | Notes live on a person, not a report thread. No ask-for-a-second-look (G13). |
| T5 | Moderator wellbeing: exposure to harmful text | Partly | Blocked words and flagged names are hidden until shown; the transcript is plain text. No hidden-by-default for severe excerpts, no exposure counter or break prompt (G14). |
| T6 | Moderator consistency | Partly | Guidelines tiers, the written guide, the AI casebook. The calibration screen is parked (G25, P3). |
| T7 | Telling moderators something needs them | Partly | Discord feed, Discord bot buttons, signed webhooks out. Not by severity: every report looks alike, and there is no email or digest (G3, G15). |
| T8 | Telling players | Covered | Notices (hold during a match), My record, appeal result notices, `platform.notify`. |
| T9 | Metrics: response time, backlog, volume | Partly | Overview: people waiting, open reports, longest wait, who is on. Appeals stats, AI status and the gate table. No time-to-decision, volume by rule, or report rate per 1,000 messages; no CSV (G15). |

### 2.8 Running it in a real game

| # | Situation | Status | Where today / what is missing |
| --- | --- | --- | --- |
| P1 | Several servers, several processes, several games | Partly | One store can serve many processes (SQLite file), but pacing state, the viewing hint, chat rooms and the term-share status are per process; one instance is one game with one staff team. Postgres and Redis are not built (G18, G9). |
| P2 | A server that is not Node (Unity, Photon, Go, Rust, C#) | Not covered | `toFetch` and recipes cover Node and Web `Request` servers. Service mode (a generated HTTP service) is designed (K4d) and not built; the site FAQ says there is no ready path (G4). |
| P3 | Player-facing text in other languages | Partly | Every word is a key with an English catalogue and a fallback; players and moderators get no shipped translation. Rule text is the game's. Notices carry kit-built English (G16). |
| P4 | Non-English and non-Latin slurs | Partly | The matcher has a language field; the corpus covers en, es, pt; whole-word matching has no word boundary for scripts without spaces (Chinese, Japanese, Thai). The AI read works in any language (G17). |
| P5 | Accessibility | Partly | Documented: a polite live region for the chat box and notices, focus kept inside dialogs, every hub key has a button, 360 px layouts, screen-reader names that never read a blocked word. No conformance audit or published statement (G28, P3). |
| P6 | Outside tools | Covered (live checks pending) | Discord feed and bot, Coop, EOS: built against fakes; the owner's live checks D10, C8 and E5 are open. |
| P7 | Staff sign-in and two-factor | Out of scope | The game's `authorize` hook (section 7). |

## 3. What the table says in one paragraph

The core loop (witness, report, decide, notify, appeal, learn) is complete and unusually careful. The gaps cluster in five places:
**(1) the chat itself only knows slurs and swearing**, so links, personal info, scams and RMT reach the room (G1); **(2) there is no
urgent lane**, so a threat or a player in crisis waits behind spam (G3); **(3) there is no privacy request path**, which an EU adopter
needs from day one (G2); **(4) the rooms have no moderator levers** beyond slow mode, and one profile covers every room (G6, G9);
**(5) the kit is Node-only in practice** (G4). Everything else is a workaround away.

## 4. The gaps that matter

Each item: what a good answer looks like, the smallest change that gets there, its risk, and a priority. Items are numbered G1 to G28;
the cross-references in the table point here. The smallest change always leaves the default behaviour unchanged (everything new is off
until an owner turns it on) and ships behind one door in the hub.

### P1: common and hurts adopters now

**G1. Chat filter rules (links, personal info, ads, RMT, scams, caps).** Covers C9, C11, C12, C14.
- *Good answer.* An owner can say "refuse lines with a link unless the domain is on my list", "refuse phone numbers and emails", "flag
  any line with `buy gold`", each with its own rule number cited in the refusal, a dry run on the last week of lines, and a hit count per
  rule. Strict profiles turn the built-in packs on; relaxed profiles leave them off. Never silently drops a line: the author is told.
- *Smallest change.* A small declarative rule list in the profile layer (`profile.filters`), evaluated in `chat.accept` after the slur
  matcher and before profanity. Rule kinds: `link` (allow and deny domains, invites, shorteners, minimum account age through the existing
  `accountAgeDays` hook), `phrase` (whole words or a short pattern, a rule number, an action), `personalInfo` (phone, email, social
  handle; street address by heuristic only as a flag), `ratio` (caps, repeated characters). Actions: `refuse`, `mask`, `flag` (files a
  system report with no reporter, so a person decides), `note`. A hit is a counter row, never a strike, never an automatic timeout.
  Hub: Settings > Advanced > "Chat filters", with the existing "Test a message" box reused. The chat box and `RestrictedChatLine` get one
  refusal word each (`link`, `personal_info`, `filter`).
- *Risk.* False positives on numbers (scores, level ranges) and legitimate links; mitigated by `flag` as the default action, a dry run
  before saving, and an exception list shared with the term exceptions. Regex denial of service: no user-supplied regex in 0.1.16,
  only a fixed pattern vocabulary and a length cap. The link rules read text only: they never fetch, resolve or preview a URL, and no
  URL reputation lookup is built (a lookup sends a link to a third party and could touch hostile content).
- *Priority.* **P1.** Every game with open chat meets links and numbers in week one; today the only workaround is the game's own
  `gate` hook or a term list stretched to hold phrases under the wrong rule.

**G2. Privacy requests: export and erase.** Covers L6, L7.
- *Good answer.* An owner can answer "what do you hold about me?" with one file, and "delete me" with one action that leaves only what
  the law and safety allow, with a written policy shown in the confirm dialog, an audit row and a receipt.
- *Smallest change.* `cw.privacy.export(person)` and `cw.privacy.erase(person, { keep })` (both `@experimental`, owner-only, audited, never
  reachable from the player routes). Export returns the person's own rows as JSON: sanctions, notices, reports they filed (note text
  only), appeals and statements, kept blocked names, signals about them, and the id list (never a raw key or IP, which are not stored).
  Erase removes reports they filed, notices, statements and kept names; blocks and sanctions in force stay by default under a stated
  safety exception (`keep: 'safety'`), or are removed with `keep: 'none'`; it also clears `kit_claims`, `kit_subject_ids` rows for the
  account ids and the Discord thread map entry, and writes a tombstone row (a subject id and a date, nothing else) so the audit trail
  still reads. One store method pair, one shared contract suite, SQLite and memory. Hub: Person page `...` menu, owner only, behind a
  typed confirm like `ACT`. `GET`/`POST /people/:ref/privacy/...`.
- *Risk.* The most dangerous thing here is partial erasure that leaves a way to re-link the person, so the contract test enumerates every
  table that holds a subject id. A legal view of "safety exception" is the adopter's; the kit ships the mechanism and wording
  templates labelled "not legal advice", never a claim of compliance.
- *Priority.* **P1.** Any adopter with EU, UK or California players is asked within months; today the answer is "edit the database".

**G3. An urgent lane for threats, self-harm and welfare.** Covers C5, C6, T7.
- *Good answer.* A report that names a threat or a welfare concern is seen first, by a person, and the game's own safety process hears
  about it at once with no chat text in the message. The reporter and, for welfare, the person in crisis, are shown the game's own help
  text (a crisis line, a safety page).
- *Smallest change.* A flag on a report reason, `urgent: true` (defaults: `threat` on, a new `welfare` reason added and off by default;
  settable in Settings > Reporting where reasons already live). Urgent open reports sort first in the existing queue and take-next, and
  carry one quiet chip that appears only when one exists; no new tab. The `report.created` event gains `urgent` (ids and the reason id
  only), the Discord feed can mention a role for an urgent post (`urgentMention`), and a reason may carry its own thank-you text
  (`reporting.reasons[].thanks`), which is where a game puts its help line for the reporter. The AI read may raise a report to urgent
  only through the existing severity field, never write it. Nothing about a welfare report ever goes to the AI or a webhook as text.
- *Risk.* Over-use turns the lane into noise (mitigated: only two reasons by default, a cap on how many urgent chips show); a welfare
  report is sensitive data (it is audited on read like any evidence, and the retention note says so). The kit does not tell a player
  they are at risk and never contacts anyone.
- *Priority.* **P1.** The "urgent ones wait behind the noise" problem is already written in the Moxgate feature contract.

**G4. Servers that are not Node (service mode).** Covers P2.
- *Good answer.* A Unity, Go or C# server runs one container beside its game and calls five documented HTTP routes: check a line,
  report, fetch notices, acknowledge, and a staff hub URL. A minimal client sample in C# and one in plain `curl`.
- *Smallest change.* K4d as designed: `chatwarden init --service` writes a Dockerfile, a config file and the mount; `@chatwarden/http`
  gains the player-side `POST /service/chat/check` (the same function the Node facade uses), `POST /service/report` and room
  seating routes, authenticated by a shared secret that the kit already uses for signing. No new matching logic. Service mode keeps
  one process per room (documented), so it ships with the per-process limits already written in the READMEs.
- *Risk.* The seam between the game's connection and the kit (who is who) moves from a function to an HTTP contract; the contract
  must be versioned and tested as the chat routes are. A larger surface to keep secure (a documented secret rotation, a body size cap).
- *Priority.* **P1.** It decides whether a large share of games can adopt at all; the FAQ already admits the gap.

### P2: common, with a workaround

**G5. Legal hold, evidence bundle and an escalation marker.** Covers L2, L4, L5.
- *Good answer.* A senior can mark a report "held for legal": the purge skips it, it reads as held, and a signed JSON bundle (the
  report, its excerpt, the actions, the audit rows, a hash, a time) can be downloaded by the owner and handed to counsel. A webhook
  event `report.escalated` (ids only) tells the game's own process. The kit forwards nothing to anyone.
- *Smallest change.* `kit_legal_holds` (report id, who, when, a closed reason code, never free text); retention skips held rows;
  `GET /reports/:id/bundle` (owner, audited) returns the bundle; one new event and one `...` item on the case.
- *Risk.* A hold is a deliberate exception to privacy promises: only the owner can lift it, and the audit says so. A bundle contains
  chat text: owner-only and never produced by a webhook.
- *Priority.* **P2.** Rare per game, severe when it happens; the workaround is raising `retention` and a manual database export.

**G6. Room tools and an emergency switch.** Covers S5, E5.
- *Good answer.* A moderator can lock a room (read-only for everyone except staff), remove a delivered line for everyone (kept as
  evidence), and turn on an emergency mode (slow mode 30 seconds, links off, new accounts read-only) with one control that they can
  undo.
- *Smallest change.* `cw.rooms.setMode(roomId, 'normal' | 'locked' | 'emergency')` beside `setPace`; `chat.accept` honours it; the room
  broadcaster gains `retract(lineId)` and the chat box greys a retracted line; hub: Settings > Advanced > "Rooms" lists rooms the process
  knows, one switch each. Room mode lives in the process, like pace (documented).
- *Risk.* Retraction on the wire needs a version bump of the chat protocol (the wire already has a version); a mode that is forgotten
  (default an auto-expiry of 30 minutes).
- *Priority.* **P2.** Workaround: close the room from the game.

**G7. New-account probation, a report-surge chip, and the victim's side of a dogpile.** Covers E5, E6, R4, C4.
- *Good answer.* New accounts can be held to slower chat and no links for their first hours; a case shows "12 reports in 10 minutes,
  10 from accounts under 2 days old" when that is true; and a victim of a pile-on sees one place to mute everyone who reported the
  same room.
- *Smallest change.* A `probation` guard in the profile (age threshold, pace multiplier, links off) built on the existing
  `accountAgeDays` hook and the pace code; the surge chip read from existing report and signal rows (no new table); the victim control is
  G10.
- *Risk.* Honest new players are punished (off by default, mild by default, never shown as a sanction); surge is a hint, never a reason
  to refuse a report (same rule as reporter accuracy).
- *Priority.* **P2.**

**G8. A linked-accounts view and ban-evasion hint.** Covers E3, E4.
- *Good answer.* On a person's page: "3 other accounts link to this person (counts only), 1 has a ban in force". At the door, a new
  account that links to a banned person is refused as the ban's own.
- *Smallest change.* The subject graph already exists. `GET /people/:ref/links` returns counts and canonical refs of merged aliases;
  the hub shows one line behind the Person page `...` menu; `doors.check` already resolves aliases.
- *Risk.* Clients behind one shared device (a family, a café) are linked and wrongly banned; the view says "shares a device", never
  proves identity, and the kit never links on IP.
- *Priority.* **P2.**

**G9. Rules per room (by tag) and staff scoping.** Covers S2, S3, S11, L1, P1.
- *Good answer.* A game tags a room (`kids`, `ranked`, `creator:alice`) and the kit applies the named profile for that tag. A moderator
  can be limited to a set of tags. One instance can serve several games.
- *Smallest change.* `profile.contexts: { tag: { overrides } }` merged for that room's lines and reports; a `scope: tags[]` on a staff
  actor from `authorize`, applied to report and person reads. Room tags already travel on reports.
- *Risk.* The profile stops being one thing, so the guide and the preview (0.1.15's "what the player sees") must say which context they
  show; test explosion in the matrix of profile by context. Scope filtering must be applied in the store reads, not the UI.
- *Priority.* **P2.**

**G10. Block, and who may message me.** Covers S3, S6, S7, C4, C8 (mitigation).
- *Good answer.* A player blocks someone: they never see each other's lines, and the game gets a list so matchmaking and whispers
  respect it. A game can set "players under N days cannot whisper".
- *Smallest change.* Make mute a block when asked (`mutes` gain `block: true`, stored the same way), export `blockedPairs(subject)` for
  the game, and a `whisperGuard` hook next to `gate`. The player's controls are the existing mute control with a second line.
- *Risk.* Block lists leak who blocked whom (staff-only, never in a player body); a game that ignores the list gets nothing.
- *Priority.* **P2.**

**G11. Phrase-only chat.** Covers S12, L1, C8.
- *Good answer.* A room can be phrase-only: a player picks from a list the game owns, shown in each viewer's language.
- *Smallest change.* A room mode `phrases` in `accept` that takes an id from the game's list, and one chat box variant.
- *Risk.* Little; the cost is the chat box variant and its words.
- *Priority.* **P2** for adopters with young players, P3 for others.

**G12. Names for entities, and protected names.** Covers N2, C13.
- *Good answer.* A game asks "may this clan be called that?" and "is this too close to a staff name?", and a report can name a clan
  as well as a player.
- *Smallest change.* `names.reserved` (a list of protected names, matched through the matcher's look-alike normaliser, so `Mod_Anna` and
  `M0d_Anna` match), a reason `impersonation`, and a report `target.kind: 'entity'` with a label, shown as a row in the case; the
  rename asks the owner of the entity.
- *Risk.* Reserved-name false positives (a real player named like staff); handled by exceptions.
- *Priority.* **P2.** Offensive names for entities in reports is part of 0.1.15's work for players; entity targets stay here.

**G13. Team workflow: second opinion, escalate, internal comments.** Covers T4.
- *Good answer.* "Ask a senior to look" on a case, a short internal comment thread on a report (staff only, never in a body for
  players), and the owner sees what is escalated.
- *Smallest change.* A report comment table (author, time, up to 500 characters; same hygiene as notes), `cases.escalate`, and the
  case's `...` menu.
- *Risk.* Comments are free text that moderators will paste chat into; the README warning already used for gap notes applies, and
  retention follows the report.
- *Priority.* **P2.**

**G14. A careful view (exposure care).** Covers T5.
- *Good answer.* A moderator may blur whole excerpts until clicked, sees how many severe lines they opened today, and is offered a
  break after a limit they set.
- *Smallest change.* One personal setting stored in the browser, "Blur excerpts until I click" (Settings > Advanced for the person,
  not for the game), plus an opt-in counter. Blur is not hiding data: the server sends the same body.
- *Risk.* Cosmetic only; do not call it protection. A counter per person is a form of tracking: kept in the browser, never sent.
- *Priority.* **P2.**

**G15. Insights.** Covers T9, T7.
- *Good answer.* Time to first decision, backlog by age, volume by rule and reason, report rate per 1,000 messages, and the AI and
  appeals numbers already shown, on one page; a weekly digest message in the staff channel.
- *Smallest change.* `GET /insights?days=` read from existing rows (no new table); one hub screen under More; a digest through the
  existing webhook and Discord feed. No per-moderator leaderboard (a standing rule).
- *Risk.* A time-to-decision number invites speed over care; show the median and the longest wait, never a rank of people.
- *Priority.* **P2.**

**G16. Shipped translations.** Covers P3.
- *Good answer.* Player and hub catalogues in Spanish and Portuguese (the languages the corpus covers), then German, French and
  Japanese by community; the generated code of conduct in the same languages.
- *Smallest change.* `@chatwarden/player-react/locales/es` and `/pt`, same for hub, loaded on demand like the AI words; a test that every
  key exists.
- *Risk.* Moderation words are sensitive; an unreviewed machine translation of a refusal is worse than the English fallback. Use
  community review and say so.
- *Priority.* **P2.**

**G17. Matching for scripts without spaces.** Covers P4.
- *Good answer.* A term in Chinese, Japanese or Thai matches inside a run of that script without matching inside an innocent word.
- *Smallest change.* `Intl.Segmenter` word boundaries for those scripts in the matcher's tokeniser, plus a per-term `matchMode`.
- *Risk.* Segmentation is not exact; precision falls. Keep the corpus gate (every term ships with lines it must and must not match).
- *Priority.* **P2.**

**G18. Shared pacing state across processes.** Covers P1.
- *Good answer.* Slow mode and flood control agree between processes without sticky rooms.
- *Smallest change.* A store-backed limiter behind an optional store method; SQLite first.
- *Risk.* A store round trip per line (the reason it is per process today); apply only to rooms with a mode set.
- *Priority.* **P2.**

**G20. A pointer to gameplay evidence.** Covers C15, R2.
- *Good answer.* A report carries an opaque match or replay id the game supplies; the case shows it, with a link template the game
  configures.
- *Smallest change.* `ReportInput.evidenceRef` (up to 128 characters, a closed character set), a `profile.reporting.evidenceUrl`
  template, and one row on the case.
- *Risk.* A link out of the hub: https only (the same rule as the appeal URL).
- *Priority.* **P2.**

### P3: rare or niche

| Id | Gap | Smallest change | Risk | Why P3 |
| --- | --- | --- | --- | --- |
| G19 | Reports about a moderator, recusal | A "staff" mark (the existing `do_not_automate` reason `staff`) routes the case to the owner and bars self-decision | Owner conflicts in a team of one | Small teams talk to each other |
| G21 | Spaced-out letters | Opt-in pass for a short list of severe terms, with the exceptions loop | False positives on initials | A report and a squeezed form of the term cover most |
| G22 | Hold for review | A filter action `hold` from G1 with a short timeout | Latency in chat; moderators must be present | A streamer or kids feature |
| G23 | Tamper-evident audit | Hash chain over audit rows | Migration cost | Trusted team, local database |
| G24 | Transparency report | Monthly counts page from G15 | Sensitive numbers published | Needed only under DSA scale |
| G25 | Calibration screen | The published eval sets as a practice queue | Becomes a performance score | Parked by design |
| G26 | Trust levels | A level from clean days, used for queue weight only | Gaming the level | G7 covers the part that matters |
| G27 | Pile-on view from the victim's side | A chip on the person page for many reports from one room | Misread as proof | G7 covers the aggressor side |
| G28 | Accessibility conformance | An audit pass and a published statement | Cost of an outside audit | Documented behaviours exist |
| G29 | Existing names scan | A script over `names.check` | None | A game can do it today |
| G30 | Creator features (follower-only, link permit) | Scoped filters from G9 and G1 | Wide surface | Narrow audience |

## 5. Recommended releases after 0.1.15

Each release is one theme, sized 6 to 12 tasks like the earlier ones, off by default, with its UI behind an existing door. The order puts
the four P1 items first and keeps each release shippable alone. All new names are `@experimental` until 0.2 and each release holds one
SQLite migration at most (numbered when the release is planned, after 0.1.15 takes its own).

**0.1.16: Chat filter rules (G1).** About 10 tasks.
1. Rule model, validation and the profile layer section (`filters`), with the evaluation order after the matcher.
2. Link rules (allow and deny domains, invites, shorteners, account age).
3. Personal-info detector (phone, email, handle; address flag only).
4. Phrase and ratio rules; actions `refuse`, `mask`, `flag`, `note`.
5. `flag` as a system report with no reporter, shown in the queue as "Filter" and never marked bad faith.
6. Hit counters and a retention clock.
7. Staff routes and permissions (`filters.read`, `filters.write`), audit rows, webhook event fields.
8. Hub: Settings > Advanced > "Chat filters", dry run on recent lines, test box; nothing new in Simple.
9. Player words and chat box refusal lines.
10. Contract suite, adopter test kit assertions, README and recipe.
UI: one Advanced panel; nothing else.

**0.1.17: Privacy and legal holds (G2, G5).** About 9 tasks.
1. Store contract: enumerate every table holding a subject or account id.
2. `cw.privacy.export` and a signed bundle format shared with G5.
3. `cw.privacy.erase` with the safety-exception policy and tombstone row.
4. `kit_legal_holds`, retention skips held rows.
5. Staff routes (owner only), audit actions, `report.escalated` event (ids only).
6. Hub: Person page `...` items (export, erase) with the typed confirm; case `...` item "Hold for legal".
7. Retention statement and legal-wording templates (labelled "not legal advice"), plus the in-product copy of what erase keeps.
8. Docs: an adopter runbook for a request, and the sqlite README rewritten.
9. Tests: no id survives erase; export contains no raw key or IP.
UI: two `...` items and a typed confirm; no new screen.

**0.1.18: Urgent first, and a kinder desk (G3, G13, G14, G15).** About 11 tasks.
1. `urgent` on a report reason and the `welfare` reason (off by default).
2. Queue sort and take-next for urgent, with one conditional chip.
3. Per-reason thank-you text.
4. Event field `urgent`, Discord role mention, a digest message.
5. Second opinion and escalate (`cases.escalate`), report comments.
6. Hub: case `...` items for both; comment thread inside the case.
7. Careful view (blur) as a personal Advanced setting.
8. `GET /insights` and one hub page under More (median, longest wait, backlog by age, volume by rule).
9. Reporting settings preview to show the thank-you text (builds on 0.1.15's "what the player sees").
10. Tests: urgent never sorts above a claimed case another moderator holds.
11. Docs: a welfare and threat handling guide for the adopter, stating what the kit does not do.
UI: one chip that exists only when something is urgent; everything else behind `...`, More, Advanced.

**0.1.19: Any server (G4, G18 if room).** About 10 tasks.
1. The HTTP contract for player-side calls (check a line, report, seating, notices), versioned.
2. `@chatwarden/http/service` routes and secret authentication.
3. `chatwarden init --service` and the Dockerfile.
4. A C# sample client and a plain `curl` recipe; a Go snippet.
5. One-process-per-room guidance and a health check that says so.
6. The optional store-backed limiter for the shared pacing state (SQLite).
7. Contract tests run over HTTP against the same cases the Node facade passes.
8. Docs and the site FAQ rewrite, after the release is on npm.
9. A test kit client for service mode.
10. An example server in another runtime (a small Go or Python server) kept in `examples/`.
UI: none in the hub; the chat box stays as it is.

**0.1.20: Rooms under attack (G6, G7, G8, G20).** About 9 tasks.
1. Room modes (locked, emergency) in `cw.rooms`, honoured by `accept`, with expiry.
2. Line retraction on the wire and in the chat box.
3. Hub Settings > Advanced > "Rooms" panel.
4. Probation guard for new accounts.
5. Report-surge chip (read-only, existing rows).
6. Linked accounts count and the door hint.
7. `evidenceRef` on reports and the case row.
8. Tests: emergency mode expires; retraction keeps the evidence.
9. Docs, recipes for raids.
UI: one Advanced panel; the surge chip and links line appear only on a case that has them.

**0.1.21: Many rooms, many kinds of player (G9, G10, G11, G12).** About 11 tasks.
1. `profile.contexts` merged by room tag, with a `which context` line in the guide and preview.
2. Staff scope by tag in the authorize result and the store reads.
3. Mute as block, `blockedPairs`, `whisperGuard`.
4. Phrase-only room mode and a chat box variant.
5. `names.reserved`, the `impersonation` reason, entity targets in reports.
6. Hub: case and person show the context; scope shown in `GET /me`.
7. Rename flow for an entity owner.
8. Test matrix of profile by context.
9. Docs for kids' and creators' setups, with what is the game's.
10. Player words.
11. One migration if the context name needs a column.
UI: no new screens; the context name appears as one chip on a case when more than one context exists.

**0.1.22: Any language (G16, G17).** About 7 tasks.
1. Spanish and Portuguese catalogues for player and hub, with a completeness test.
2. Generated code of conduct in those languages.
3. Segmenter-based matching for unspaced scripts, with the corpus gate.
4. Corpus support for those scripts (service and loader).
5. Locale loading on demand (hub and player).
6. Docs and a translation guide for community packs.
7. Tests with real-shaped lines in each script.

**Later (P3, no release planned):** G19 and G21 to G30 (hold for review, tamper-evident audit, transparency report, calibration
screen, trust levels, accessibility conformance, the names scan, creator features), Postgres and Redis (K14), engine SDKs (K14),
AI acting R3 and Watch R4 (the owner's gate), the live checks D10, C8, E5, and the Moxgate engine switch.

If the owner expects non-Node adopters soon, move 0.1.19 ahead of 0.1.17; nothing in 0.1.17 or 0.1.18 depends on it.

## 6. What the kit must NOT do

These are not gaps. Building any of them would be a mistake.

- **Store, fetch, preview or forward child sexual abuse material.** The kit holds text only. Link rules match text and never fetch,
  resolve or preview a URL. No webhook, Discord post or bundle carries a line unless the adopter opted in and signed the endpoint.
  Detection and reporting go through Coop and HMA; the Coop adapter never sets the `csam` flag.
- **Judge legality.** The kit does not decide whether a threat is credible, whether a line is a crime, or whether a duty to report
  exists. It can mark a case, hold it, and hand its ids to the game's own process.
- **Report to law enforcement, NCMEC or a regulator.** Never automatically. The adopter's counsel decides who is told, and the kit's
  hand-off is an event with ids and a bundle only the owner downloads.
- **Give legal advice or claim compliance.** Templates say "not legal advice".
- **Detect or profile minors.** No age model, no guessing from behaviour. The game tells the kit which room is a kids' room.
- **Diagnose a player in crisis or contact them.** The kit routes a report and shows the game's own help text.
- **Shadow-ban** or hide a restriction from the player. Players are always told, with the rule and the reference code.
- **Let the AI decide** a ban, or act at all, until the owner's R3 gate is met. A filter rule or a signal never writes a sanction either.
- **Moderate voice, images or other platforms' chat** (section 7 says who does).
- **Detect VPNs, link people by IP address, or fingerprint devices beyond the game's own client key.**
- **Rank moderators.** No per-person leaderboards, no exposure score shown to others.
- **Hold more than it needs.** No raw IP, key, email or name; free text only where a moderator needs it, on a short clock.

## 7. What belongs to the adopting game

- **Authentication of staff and players** (`authorize`, `identify`), two-factor, and who is a moderator.
- **Age checks, parental consent and the decision that a room is for children** (COPPA, the UK Children's Code, and similar).
- **Legal duties and contacts:** whether and how to report to NCMEC or a regulator, a data protection officer, the privacy policy,
  retention choices beyond the defaults, the legal basis for keeping a ban list.
- **Crisis help text and what happens when a player may be at risk** (the game's safety team, local resources).
- **Voice chat moderation, image and avatar moderation, UGC review, and anti-cheat detection.**
- **Matchmaking and gameplay consequences** of a block, a ban or a rename; acting on `rename.required`; showing a notice at the right moment.
- **Translation of rules and the code of conduct text**, and review of any translated moderation wording.
- **Staffing, shifts and welfare**: who is on, break policy, counselling for moderators.
- **Encryption at rest, backups and access to the database.**
- **Sticky rooms or a shared store** for more than one process, until the shared limiter ships.
- **The reasons a rule exists** (the Community Rules are the game's words); the kit only cites them.

## 8. What changes in the docs when this is accepted

`docs/status.md` "Next" gains the release list above; `docs/plans/follow-ups.md` gains a pointer from each parked item to its G number;
the product-scope table (`2026-11-09-product-scope.md`) is not rewritten. Its still-unbuilt rows map here: AutoMod, links and the personal-info guard are G1; per-context policy is G9; block and minor mode are G10, G11 and G9; raid protection and room tools are G6 and G7; data requests and evidence bundles are G2 and G5; the analytics dashboard is G15; service mode is G4. Hold for review, trust levels, the transparency report and the immutable audit are G22, G26, G24 and G23, parked.
