---
status: owner decisions A to C and the 0.2.0 update recorded; drafting rulings in section 14 await the owner
updated: 2026-11-17
release: 0.2.0
---

# Offensive names in reports, and "What the player sees"

Two changes that ship in 0.2.0, one release that also carries other themes designed in parallel (filter rules and privacy; the urgent
lane, desk and rooms; any server, many rooms and languages). **Part A, names in reports:** a player can be reported for their name,
and a moderator who decides that report can ask the player for a new name, alone or together with a sanction, using the rename
machinery 0.1.9 built. **Part B, "What the player sees":** every hub action that sends a player a notice, or deliberately sends none,
shows the notice as the player will see it, live as the choice changes, so a moderator never has to guess what a click does to the
other person.

**Compatibility stance (owner, 2026-11-17).** Chatwarden has no users yet, so this note designs the cleanest behaviour and carries no
compatibility path: no saved-list handling, no optional fields kept for older servers or clients, no version gates, no byte-identical
bodies. Every behaviour that differs from 0.1.14 is listed in section 12 ("Breaking changes").

Written against `main` at 0.1.14. The rename design it builds on is `docs/design/2026-11-12-appeals-and-names.md` (5.3 to 5.7); the
reporting reasons are described in `docs/design/2026-11-10-editable-ladder-and-roadmap.md` (Part 1b). This change adds **no table and no
column**, so it contributes nothing to the release's one migration (26); section 12 says so for the controller's list.

## 1. Why

**Names.** The kit can already refuse a bad name at sign-up (`cw.names.check`) and ask an existing player to change one
(`POST /people/:ref/rename`, the `rename_required` notice, `rename.required`). Two gaps remain. A player has no way to say "this
player's name is the problem": the default reasons (`harassment`, `hate`, `sexual`, `threat`, `spam`, `personal_info`, `cheating`,
`griefing`, `afk`, `other`) are all about chat or play, so a name report arrives as "Something else" with a note and the ladder has
nothing to suggest. And once a moderator has decided that report, asking for a new name is a separate trip to the Person page and a
second form. The default Community Rules already have the rule for it (CR 7, "No offensive names"); nothing connects a report to it.

**The preview.** Today the hub says what a click does to a player in scattered one-liners: Simple's "{name} sees these 3 lines and Rule
2" (`hub.simple.sees`), the Person form's "The player is not sent a notice about this" (`hub.person.form.noNotice`), the quick
"Nothing wrong here" hint. None of it is the notice. A moderator picks "Restrict chat 24 hours" without seeing that the player will get
a dialog titled "Your chat is turned off", the rule label, an end time and their own lines; picks "Make it lighter" on an appeal
without seeing that the player will receive two notices; revokes a sanction not knowing the player never sees an unseen notice. The
owner's rule: every action shows what the player sees, or says plainly that nothing is sent.

## 2. Goals and non-goals

### Goals
- A default report reason `name`, "Inappropriate name", mapped to CR 7, in `DEFAULT_REPORT_REASONS`.
- In a case decision, "Ask for a new name" beside the usual choices, combinable with a sanction (rename plus warning), sent in the same
  request as the decision, using the existing 0.1.9 machinery and staying behind `names.renames` (off by default), with a one-line hint
  when it is off.
- One "What the player sees" panel on every hub action that sends or withholds a notice, quiet, inside the action, the same in Simple
  and Detailed, always reflecting the current choice.
- The panel's words come from ONE source shared with player-react, so the preview cannot drift from the real notice.
- No moderator-only field can reach the panel, and the panel is usable with a keyboard and a screen reader.

### Non-goals
- Any change to what a notice says. This release changes no existing notice word; the preview shows the words players already get.
- Showing the preview in another language or in an adopter's own wording (4.7 says how to add it later).
- A server route that renders previews; a store change; a migration; a new audit action, event or permission.
- Telling the reporter when a decision only asks for a new name (the core thanks a reporter only for a non-note sanction; section 6).
- Previews for the Discord bot's buttons, the Coop callback or the AI's own actions (the AI still acts on nothing).
- Skipping the AI read for `name` reports (section 10, follow-up).
- Enforcing a rename: the kit never blocks a player; the game holds them at its rename screen with `pendingRename`.

## 3. Part A: offensive names in reports

### 3.1 The reason `name`

`DEFAULT_REPORT_REASONS` (`packages/core/src/reporting.ts`) gains one entry, after `personal_info`, in the Chat group the player's
report dialog already shows:

| Field | Value |
| --- | --- |
| `id` | `name` |
| `label` | Inappropriate name |
| `hint` | An offensive or inappropriate player name |
| `group` | Chat |
| `rules` | `[7]` (CR 7, "No offensive names", present in all three starter flavours) |
| `asksNote` | false |
| `enabled` | true |

Why Chat: a name is read in the chat and the lobby beside the messages, and the report dialog's groups are Chat and Gameplay; a third
group for one reason would be heavier than the problem. Why no note: the moderator reads the name from the report itself. The list is
now 11 reasons (the limit is 20); the order of the others does not change. It is simply a default: the list is defined in one place and
there is no migration of saved lists to describe.

Consequences, each pinned by a test (section 9): `suggestedRule` returns 7 for a `name` report, so the decision bar opens on CR 7 (and
`uncovered` where an adopter retired rule 7, as for any reason); `legacyCategoryOf('name')` is `other`; `GET /reporting`, the staff
`GET /reports?reason=name` filter and report intake need no change (they read the list); the AI read receives the reason as the hint it
always is.

### 3.2 "Ask for a new name" in the case decision

**Where it appears.** In the decision bar's actions area (`case/DecisionBar.tsx`), after the action list and its Add button, one quiet
row: a checkbox "Ask for a new name" with a one-line hint ("They get a notice asking them to pick another name. This applies no
sanction by itself."). It is:
- **Shown at once** when the report's reason is `name`. It starts unticked: it sends a notice and calls for action by the game, so it is
  a deliberate choice.
- **Behind the existing disclosure** for every other reason: it appears when the moderator opens the action editor ("Edit" on the
  suggestion card, or any added action), so the always-visible bar does not grow for reports about chat (the owner's clean-core rule;
  this is "or the moderator chooses it").
- Only with the verdict "fair" (the one verdict that may act on the reported person). Choosing "Not a problem" or "Bad faith" clears it
  and says so through the bar's live region, as dropped actions already are (`hub.decide.announce.dropped`). The reported person only:
  a rename is never asked of the reporter or anyone else.
- Only when `features.renames` is true (`GET /me`: `names.renames` on and the store can release a rename) and the role has
  `sanctions.apply` (the existing `useFeatures().renames`). Otherwise the row is not drawn (3.3 covers the `name` report).

**What it holds.** `DecisionForm` gains `rename: { rule: string } | null`. The row carries one small field, the rule the player is told
(a select of the active numbered rules, no "No rule covers this": a rename always cites a numbered rule, 3.4). It starts on the first
action's rule, else the report's rule, else empty, and is required (a problem line like any other field). The reason is the decision's
reason (private, as for a sanction).

**Combining.** Rename plus a sanction is one decision: "Warning" for the target and the row ticked. Rename alone is also valid: verdict
fair, no actions, row ticked, a reason. The notices (sanctions first, then the rename) are described in 4.3.

**The send: one request.** `POST /reports/:id/decide` gains an optional `rename: { rule: number }`. The decision still goes through the
5 second hold and Undo (nothing is sent until it ends). The server does, in this order, in one request:
1. the claim gate once, as the decide route does today (so the rename can no longer fail on a claim);
2. `cw.reports.decide` (or `decideAs`) exactly as before, with the body minus `rename`; its replay semantics are unchanged (a repeated
   body is `replay: true`);
3. if the decision wrote and the body asked for a rename: `cw.names.requireRename({ subject: the reported person, actor, reason: the
   decision's reason, rule })`.
The answer is the decision's answer plus `rename: { status: 'asked' | 'already' | 'failed'; error?: 'off' | 'not_found' | 'invalid' }`
(absent when none was asked). `already` is `pending` from the core (a request is waiting): a rename that is already asked is the goal
met. The server refuses before writing anything with 400 `invalid_request` when `rename` comes with a verdict other than `upheld`, with an
action list that acts on the reporter, or without a numbered rule; with 403 when the caller lacks `sanctions.apply` (as for any
sanction); and with 404 when renames are not available (`names.renamesEnabled()` false), checked before the body as the rename route
does. It audits `name.rename_required` for the person (best-effort, after the write), beside the decision's own audit row.

Why one request, in this order:
- A rename after a decision can fail without harming the decision; the other order could ask a player to rename and then lose the
  decision to a conflict with another moderator, after the notice has gone out.
- One request is one claim check and one result; the hub's headless controller, an embedded hub and any other client get the same
  behaviour with no client-side sequencing, and a retry is the same body again (a replay of the decision, an `already` for the rename).
- The decision's idempotency key (report, verdict, actions) is unchanged, so `rename` is not part of the decision's identity; a replay
  with a rename the first call did not carry asks for it then.

**When the rename step fails after the decision wrote** (`failed`: renames switched off between the form and the send, or a store
fault): the decision stands and the result block says so: "Decision recorded, but asking for a new name did not go through." with a
pointer to the Person page (the Person form can send it alone). `already`: "Decision recorded. They have already been asked to choose a
new name." Nothing is rolled back.

**The headless controller** keeps `rename` on the submitted entry and exposes the answer on `DecisionState.done` (`rename?:
'asked' | 'already' | 'failed'`), so an embedded hub and a piece behave like the shell. These are `@experimental` additions.

### 3.3 When "Ask for a new name" is off

`names.renames` is off by default because a rename only works once the game blocks the old name. On a `name` report, with renames
unavailable, the actions area shows one plain line where the row would be:

- Setting off: "Asking for a new name is switched off. Turn it on in Settings, Advanced, Names." For a role with `policy.write` (the
  owner) "Settings, Advanced, Names" is a link to `#/settings/advanced`; everyone else sees the words only.
- Setting on, but the store cannot release a rename (so `features.renames` is false): "This setup cannot ask for a new name: its store
  cannot release one." No link.

The hub tells the two apart from the resolved profile it already reads for the decision form (`profile.names.renames`) against
`GET /me`. A report with another reason shows neither line. The line is words, not a control, and is not drawn when the role cannot decide.

### 3.4 A rename always cites a numbered rule

0.1.9 left the rename's rule optional and defaulted it to the slur filter's rule (CR 1, "No slurs or hate"), which tells a player their
name broke the hate rule. With no installed base to protect, the rule becomes required everywhere: `cw.names.requireRename({ ..., rule })`
takes a required citable numbered rule (a missing one is `invalid`); `POST /people/:ref/rename` requires `rule` (400 `invalid_request`
without it); both hub forms require it (the Person form's rule select stays, "No rule covers this" is not offered for a rename). The
preview can then show the exact rule label the player will read. The `autoRestrictRule` default is no longer used for renames.

## 4. Part B: "What the player sees"

### 4.1 The principle

One panel per action, inside the action, quiet. It answers three questions in this order:
1. **Does the player get a notice?** If yes, the notice as the player will see it (4.4); if no, one plain line naming that.
2. **Who else is told?** The person who reported, when the core thanks them; otherwise one line saying they are not.
3. **What else changes for them?** One line per effect ("They cannot chat until Fri 3:00 PM").

It always reflects the current choice: a pure function of the form's state, recomputed on every change, with nothing to press. It is not
a new screen, modal, tab or menu entry. Where a form has a send button, the panel is the last thing above it.

### 4.2 Every action that sends or withholds a notice

Found by listing every `post(...)` and `PUT/DELETE` of `hub-react/src/client.ts` and tracing each to a notice-writing call in core
(`createForSanction`, `createMessage`, `createReportOutcome`, `withdrawGroup`, `withdrawRenames`).

| Action (client method) | Where in the hub | What the core does to notices | Panel |
| --- | --- | --- | --- |
| `decide` | Decision bar (Detailed, Simple "Something else", AI accept); Simple card's one-tap primary and warning; quick keys | A sanction notice per non-note action, per person; `report_outcome` to the reporter on `upheld` with a non-note action (when `reporterFeedback`); a `rename_required` notice when `rename` is sent; none for notes or dismissals | Yes (4.3 A) |
| `decide`, no action | "Nothing wrong here" button and key; Simple's button | none | One line, on the button (4.3 B) |
| `dismissOpen` | "Close more reports at once" window | none | One line in the window (4.3 B) |
| `applySanction` (sanction) | Person page, Sanction form | none (a direct sanction sends no notice; chat shows `RestrictedChatLine`) | Yes (4.3 C) |
| `applySanction` (note) | Person page, Note form | none | Yes (4.3 D) |
| `rename` | Person page, Sanction form, "Ask for a new name" | `rename_required` notice | Yes (4.3 E) |
| `revokeSanction` | Person page, Revoke | withdraws the sanction's notices; none new | Yes (4.3 F) |
| `decideAppeal` | Appeal card | `appeal_upheld`, or replacement sanction notice plus `appeal_reduced`, or `appeal_revoked` (and withdraws the original) | Yes (4.3 G) |
| `claimCase`, `releaseCase`, `takeNext`, `viewing` | Claims | none | No (no player effect) |
| `closeGap` | Rule gaps | none | No |
| `setAutomation` | Person page, Do not automate | none | No |
| terms, exceptions, community, reasons, policy save, reset | Words, Settings | none (a term changes what the chat refuses, which is not a notice) | No |
| AI: `readAgain`, `dontTeach`, `aiActingStep` | Case, Settings | none (the AI still acts on nothing; the shadow dialog already says so) | No |

Simple's "Something else" opens the same bar, so one panel serves both modes.

### 4.3 The exact behaviour of each panel

Throughout: "the player" is a person the action's notices are for, named with `personName` and so masked when flagged (never the raw
handle); the notice is rendered by the shared view (4.5) as plain text and a drawn button, never a control; times are the moderator's
local time; the notice's Reference row reads "Made when it is sent". The caption under the heading is always "Shown in the player's
language. This preview is in English." (4.4).

**A. A case decision** (inputs: verdict, actions, rename row, the report's target and reporter, each action's chosen lines, the rules,
`features.appeals`, `reporterFeedback`).
- Recipients and order mirror the core: each person with a non-note action, people and kinds in the core's sort (by person ref, then
  kind), one sanction notice per non-note action; then the reporter's thank-you; then the rename notice for the reported person (made
  after the decision). A person with two notices sees them one at a time, oldest first, so the panel prints "Notice 1 of 2" above each
  and one line "The player sees them one at a time."
- A sanction notice shows: referee card, title ("You have a warning", "Your chat is turned off", "You cannot join public rooms", "You
  are banned"), body, the facts (Rule: "Community Rule 2: ..."; Until with the end and "in 24 hours", or "No end date" for a permanent
  one; a warning shows "On your record until" 90 days on), Reference, "Your messages that led to this" with the chosen lines (up to 5,
  as masked by the server), the appeal button when `features.appeals` is on, and for a warning "Press Acknowledge to confirm you saw
  this." with an Acknowledge button, "Got it" for the others.
- The reporter's notice: "Thanks for your report" with "A moderator looked at your report and took action. We do not share what was
  done." and "Got it", under "The person who reported sees". Present only on `upheld` with at least one non-note action, and only
  when the kit's `reporterFeedback` is on (`GET /policy`). When the plan sends the reporter nothing at all (no thank-you, and no sanction notice of their own), the effects say "The person who reported is not told."
- The rename notice: title "Please choose a new name", its body, Rule row, "Got it". No lines, no reference, no end, no appeal.
- Effects (one line each, moderator-facing): chat off until T / until lifted; no public rooms until T / until lifted; banned until T /
  until lifted; the warning stays on the record for 90 days; "Their network address is also restricted for 24 hours." when an action
  includes the IP; "They are asked to pick a new name before they can chat." for the rename; the reporter line above.
- Nothing sent: a decision with no non-note action and no rename: "Nothing is sent to the player. Only your team sees this note." when
  every action is a note; "Nothing is sent to anyone. The report is closed." for a dismissal. A bad-faith verdict with a sanction on the
  reporter shows that reporter's notice under their own name.
- With nothing chosen the panel reads "Choose what happens to see what the player is sent." A form problem (no rule, a bad length) never
  blanks the panel: it shows what the valid part would send.

**B. One-click dismissals.** "Nothing wrong here" (the button, key 2, Simple's button) and "Close more reports at once" send no notice.
Each carries one plain line: on the button as its description ("Nobody is told and nobody is marked." exists today; it gains "Nothing is
sent to anyone."), and in the sweep window above the confirm button. These are not forms with a current choice, so they get the line,
not a panel (ruling 5).

**C. Person page, Sanction form.** A direct sanction sends no notice, so the panel says so: "No notice is sent. Only a decision on a
report sends one." and shows the one thing the player does see, in the kit's own wording: for "Restrict chat" the restricted-chat line
the chat box shows when they next try to type ("A moderator turned off your chat until Fri 3:00 PM (in 24 hours)." with the chat card);
for the public-rooms restriction and a ban, "Your game shows its own message when they try to join; the kit sends none."; for a warning,
"A warning from a person's page is on their record for staff only." Effects: the end-time line of A and the IP line when ticked. Nothing
is shown until a kind is chosen.

**D. Person page, Note form.** "Nothing is sent to the player. Only your team sees this note."

**E. Person page, "Ask for a new name" (and A's rename).** The rename notice and its effect line. The panel cannot know that the person
is already waiting on a rename (it reads no history); the send answers 409 and the form says so, as today. Combined in A with a ban or
public-rooms restriction the effect line adds "They will be asked once they can play again."

**F. Revoke.** No new notice is sent. The panel says what changes for the player: the sanction's notice is withdrawn (one they have not
seen is never shown; a seen one leaves their record) and what lifts: "They can chat again at once." (chat), "They can join public rooms
again." (area), "They are no longer banned." (ban), "The warning is taken off their record." (warning). With appeals on: "If they
appealed, the appeal is closed with no message." A note: "Nothing changes for the player. Only your team sees this note."

**G. Appeal decision.** The three outcomes become a choice (Keep the decision, Make it lighter, Remove it) with a "Send decision" button,
in place of three immediate buttons (breaking, section 12). The panel follows the choice and the lighter picker's kind and length:
- Keep: the "We looked again and kept the decision" notice (title, body, Rule row, Reference of the original sanction, "Got it");
  effect: "The sanction stays as it was."
- Lighter: **two notices**, in this order: the replacement sanction's notice (title and body of its kind, an end that is
  `min(original end, original start + chosen length)`, no lines, a warning's Acknowledge, the appeal button as for any notice when
  appeals are on) then "We looked again and changed the decision". Effects: the new end ("Their chat restriction now ends Fri 3:00 PM;
  it was Mon 9:00 AM") and "The first notice is withdrawn." If the replacement would already be over: "The lighter decision has already
  run its course, so it is on their record as ended." and the notice reads as ended.
- Remove: "We looked again and removed the decision"; effects: "The sanction is removed and the first notice is withdrawn." plus the
  by-kind line of F.
- Nothing chosen: "Choose what happens to see what the player is sent." The statement the player wrote is never shown here.

### 4.4 The panel

```
What the player sees          Shown in the player's language. This preview is in English.
+--------------------------------------------------------------+
|  [card]  Your chat is turned off                            |
|  A moderator turned off your chat. You can still play.      |
|  Rule      Community Rule 2: No insulting, ...              |
|  Until     Jan 16, 2027, 3:00 PM (in 24 hours)               |
|  Reference Made when it is sent                              |
|  Your messages that led to this                              |
|    Jan 15, 2027  you are a *****                             |
|  Think this is a mistake?  (button)         Got it (button) |
+--------------------------------------------------------------+
They cannot chat until Fri 3:00 PM.
The person who reported is not told.
```

- **Placement.** Inside the decision bar's dock, directly above the submit row (the last thing read before Decide); on the Person forms
  directly above the Apply button; in the revoke form above Revoke; in the appeal card above Send decision. In Simple's card, under the
  buttons, replacing the `hub.simple.sees` sentence (ruling 4). Not a modal, tooltip or tab.
- **Quiet.** A small heading in the hub's hint style, one hairline box (the Notice style without tone), the notice at the player
  components' own scale, no new colour. The referee card is the hub's existing `Card`. Colour means what it already means.
- **Static.** Nothing in it takes focus: the Got it and appeal buttons are drawn as text ("Button: Got it") in a `span`. The notice block
  carries `lang="en"` because its words are English whatever the hub's language.
- **Weight.** The panel loads in a lazy chunk (the hub's first-load budget is near its limit); until it arrives the slot holds one
  line of height so the form does not jump.
- **The caption** says what the owner asked and, because the preview is in English, says so. If the adopter's game words the notice
  differently, the player sees the game's words, not these (4.7).

Words (hub catalog, `hub.preview.*`, every one through `t()`): the heading, caption, "Notice {n} of {total}", "The player sees them
one at a time", "{name} sees", "{name}, who reported, sees", "Made when it is sent", "Button: {label}", the nothing-sent, effect and
rename-off lines of 4.3 and 3.3, and "Choose what happens to see what the player is sent." The notice's own words are not in this
catalog: they are the shared words of 4.5.

### 4.5 One source of truth for the words: a core subpath

**Decision.** Move everything that turns a `PlayerNotice` into text out of player-react and into a small pure module of
`@chatwarden/core`, the subpath **`@chatwarden/core/notice-copy`**, and have both player-react and hub-react import it:

- `NOTICE_WORDS`: the English strings (title, body, fact labels, hints and button words for every notice kind, plus the two
  restricted-chat lines), keyed by the keys player-react already uses (`player.notice.title.warning`, ...). player-react's `en` is
  `{ ...NOTICE_WORDS, ...the rest }`, so adopter translations keep working and `PlayerText` is the same union.
- `noticeView(notice, { words, locale, timeZone, now, record })`: the pure function behind today's `NoticeCard` and `Facts`: title, body,
  the rows of facts (rule, given, until or ended or no end, on-record-until, reference), the reference hint, the lines, the acknowledge
  hint and the button word. player-react renders it; the hub preview renders it. `titleKey`, `bodyKey`, `isSanction` and the 90-day
  constant come with it; `dayText`, `untilText` and `timeLeft` move there (player-react re-exports them).
- `communityRuleLabel(ref, title?)`: the one place "Community Rule 2: Title" is built; `CommunityRules.label` calls it and the hub calls
  it with the titles from `GET /policy`.
- `planNotices` and `appealReplacementEnd`: 4.6.

**Why a core subpath and not another way.** Three ways were weighed against "least drift":
1. *The hub imports player-react.* The words would be the real catalog, but the hub would depend on a React component library, its
   stylesheet and its Dialog, pull player-react into the hub-element bundle, and player-react would have to export internals
   (`titleKey`, `Facts`) as public API. Rejected: wrong dependency direction, and size.
2. *The server returns a rendered preview* (a route such as `POST /reports/:id/decide/preview`). The data would be exact, but the words
   would still have to live somewhere the server can reach, which is core, so the shared module is needed anyway; and it adds a route,
   a permission, an audit question and a request on every keystroke and every select change. Rejected: more surface for the same
   drift guarantee.
3. *Copy the strings into the hub catalog.* Cheapest, and exactly the drift the owner wants to avoid. Rejected.

A core subpath wins because both packages already depend on core (hub-react imports `LADDER_TABLE`; player-react imports its types), the
module is pure data and functions with no React and no `node:` import (core stays browser-safe), and one `noticeView` means the player
and the preview cannot render different facts from the same notice. The subpath (rather than the package root) keeps player-react from
loading the engine to get ten strings: core has `sideEffects: false`, and the new `exports` entry (with a `typesVersions` entry, as
player-react does for `./chat`) lets a bundler take only this file.

**What stops drift** (section 9): every `NoticeKind` has a title and a body in `NOTICE_WORDS` (a new kind without words fails a test);
player-react's `en` contains `NOTICE_WORDS` exactly; the strings equal the 0.1.14 snapshot; `NoticeCard` and the preview render the same
`noticeView` output for a matrix of notices; and the plan (4.6) is compared with the notices the real services write.

### 4.6 Where the preview's data comes from

**The notice drafts: computed in the browser from the form, by a pure core function.** `planNotices(op, context)` in the same subpath
takes a description of the action (an operation, its verdict, actions, lengths, rules, lines; never a reason, an evidence note, a gap
note, an actor, a staff ref, an IP flag or a group id) and the context (the time, a rule-label function, `reporterFeedback`, whether
appeals are on, a reference placeholder) and returns the notices the core would write, in order, for each recipient, as `PlayerNotice`
drafts, plus effect codes the hub words. It has one result for each of: a decision, a direct sanction, a rename, a revoke, an appeal
decision and a dismissal. `appealReplacementEnd(original, to)` is the one function for a reduction's end time, now called by the appeals
service and the plan alike. A parity suite runs the real services over a matrix of inputs and asserts the notices they write equal the
plan's (kind, order, recipient, rule label, end time, excerpt text, acknowledge flag), so any change to a service that is not mirrored
in the plan fails core's tests. (Hub and server ship together in this release, so there is no version gate between them.)

**One server-side fact the browser cannot compute: how the player's own lines read.** A notice quotes a line as the room saw it
(`delivered`), or, for a blocked line, the raw text with only the matched terms starred, which needs the matcher. So `GET /reports/:id`
gains `noticeText: string` on each excerpt line that is some person's own, computed by the same function the notice uses
(`NoticeService.excerptOf` is split so `cw.notices.lineText(line)` is its per-line step). It carries nothing the staff payload did not
already carry (a masked form of `raw`). The hub never falls back to `raw`.

**Whether the reporter is thanked.** `GET /policy` gains `notices: { reporterFeedback: boolean }` (`cw.limits.reporterFeedback`).

### 4.7 What the preview does not know

- **A game that words notices differently.** The caption says so. A later `previewWords` prop on `<Hub>` (an adopter's own catalog,
  spread over `NOTICE_WORDS`) is the follow-up (section 11); it needs no change to this design.
- **The adopter's `appealUrl` link.** With kit appeals off, an adopter's own link may still appear on the player's notice; the hub cannot
  know, so the preview draws the appeal button only when `features.appeals` is on.

## 5. Wire changes

Required, not optional: client and server ship together.

| Route | Change |
| --- | --- |
| `POST /reports/:id/decide` | body gains optional `rename: { rule: number }` (section 3.2); answer gains `rename: { status, error? }` when asked |
| `POST /people/:ref/rename` | `rule` is now required |
| `GET /reports/:id` | each own excerpt line gains `noticeText: string` |
| `GET /policy` | body gains `notices: { reporterFeedback: boolean }` |
| player routes, `PlayerNotice`, store, events, audit actions, permissions | none |

New core API: the subpath `@chatwarden/core/notice-copy`, `NoticeService.lineText` and `cw.notices.lineText(line)` (staff side,
"the masked text a notice would quote; never send a raw line"); `requireRename`'s `rule` is required. New hub API: `DecisionForm.rename`,
`DecisionEntry.rename`, `DecisionState.done.rename`. All `@experimental` until 0.2 ships; the panel itself is internal.

## 6. Edge cases

- **Renames off or unsupported.** The row is not drawn; on a `name` report the one-line hint appears (3.3). If the setting turns off
  between the form and the send, the server answers 404 before writing anything and the form returns with its error, as for any
  refused send.
- **Appeals off.** No appeal button in any notice. The appeal card is not reachable. The revoke line about appeals is not drawn.
- **A custom notice translation or wording.** Not visible (4.7); the caption is the honest label.
- **A notice kind the hub does not know.** `noticeView` falls back to the generic title and body (`player.notice.title.fallback`), as
  player-react does. The plan only emits kinds the core knows.
- **A sanction with no notice.** A direct sanction, a note, a dismissal, a revoke: the panel says "no notice" in words, never an empty box.
- **A warning.** Shown with Acknowledge and "Press Acknowledge to confirm you saw this." No end: "On your record until" shows 90 days on.
- **A permanent ban.** "No end date"; effect "They are banned until a moderator lifts it." Needs `sanctions.apply.ban_permanent`, as before.
- **A combined rename and sanction (two notices).** "Notice 1 of 2" and "Notice 2 of 2" for the same person, sanction first. With a ban
  or public-rooms restriction the effect adds "They will be asked once they can play again."
- **A decision on several people.** Each person's notices are listed under their own name, in the core's order.
- **Two actions of one kind on one person.** The form already refuses them (`hub.decide.error.duplicate`); the panel shows what the valid
  actions would send.
- **No lines chosen, or the report has no lines of the player** (a name report often has none). The notice has no "Your messages"
  section, exactly as the player's does.
- **A blocked line.** Starred with only the matched terms, as the player's is (`noticeText`); never raw.
- **A flagged name.** The hub's hidden label in every sentence of the panel, with no Show control inside it (the case and Person page have
  theirs). A notice never contains a name.
- **A person with no staff-visible handle.** "Person 7K2M", as everywhere else.
- **The hold and Undo.** The panel is not shown while a decision is held or sending (the form is hidden); after Undo the form and panel
  return as they were. A failed send returns the form with its panel.
- **A rename for a person already asked.** The core's `pending` becomes `rename.status: 'already'`; the result reads "Decision recorded.
  They have already been asked to choose a new name."
- **A decision replay.** A repeated send is `replay: true`; the rename step runs again and answers `already` if the first one wrote.
- **Reporter feedback off.** The reporter's notice is absent and the line says they are not told.
- **A report whose reporter is also acted on** (bad faith): their sanction notice shows under their name; they are not also thanked.
- **A retired or unknown rule.** The core's label ("Community Rule 9", no title), as the player would see it.
- **A rename-only decision.** The reporter is not thanked (the core thanks only for a non-note sanction); the effect line says so.
- **Time.** An end time is `now + length`, recomputed each minute while the panel is open. The sent notice's end is the send time plus
  the length (up to 5 seconds later, because of the hold); the panel shows no seconds, so this is invisible.

## 7. Privacy

- **The panel's input is whitelisted by type.** `planNotices` accepts, per action, only: a person's display token, a kind, a length, a
  rule, a list of already-masked line texts with their day. It has no field for a reason, an evidence note, a gap note, an actor, a
  moderator name, a staff ref, a group id, a sanction id, the IP flag, an AI read or an appeal statement. A leak needs a type change,
  which a reviewer sees; tests also scan the rendered DOM (section 9).
- **Lines.** Only the chosen lines the form already restricts to the person's own (`ownLineIds`), through `noticeText` (masked as the
  player's is), never `raw`.
- **Names.** Only `personName`, the hidden label while the server flags the handle.
- **The appeal statement** is never an input to the preview; outcome notices carry no lines.
- **Nothing is stored or sent.** The preview makes no request. No log line, audit row or event is added for it.
- **`cw.notices.lineText`** is staff-side and returns only the masked text, from a line object the staff report already holds.
- **The rename** keeps its contract: the notice names no name, the reason stays private, the audit row is the existing
  `name.rename_required`.

## 8. Accessibility

- The panel is a `section` with `aria-labelledby` its heading (an `h3` inside the dock, `h4` for a notice's title so the outline stays
  ordered). It contains no focusable element; the drawn buttons are text.
- The mock notice is exposed as text in reading order (heading, body, facts as a term list, lines as a list, the button words), so a
  screen reader reads what the player will read. It sets `lang="en"`.
- It is not a live region (it would chatter on every select change). The form's existing polite region (`draft.announce` in the bar, a
  local one on the other forms) says one short sentence after 600 ms without a further change: "Preview updated: they see a warning." /
  "Preview updated: nothing is sent." The first render is silent.
- Meaning never relies on colour: the kind is written in the title and the effect lines; the referee card is decoration (`aria-hidden`).
- Contrast and themes use the hub's tokens in both themes; at 360 px the panel is one column, long words wrap, no sideways scroll;
  nothing animates.
- The rename row is a labelled checkbox with its hint as `aria-describedby`; the off-hint is a paragraph, and the owner's link is a real
  link with a visible focus ring. The rename result is announced through the existing result region.
- The appeal card's choice is a radio group (legend "Decision") with the three outcomes.

## 9. Tests that pin it

Test-first, broad, targeted runs, fake clock throughout.

**Reason.** `name` is the 11th default after `personal_info`, group Chat, rule 7, no note, enabled; every flavour's CR 7 is "No offensive
names"; `suggestedRule` is 7, `uncovered` when CR 7 is retired; `legacyCategoryOf('name')` is `other`; `GET /reporting` shows it, report
intake accepts `reason: 'name'` and stores `reportedReason: 'name'`; every existing test that counted 10 reasons counts 11.

**Words and view (core).** Every `NoticeKind` has a title and body; the strings equal the 0.1.14 snapshot; `noticeView` for every kind
and shape of fact (warning, timed, permanent, ended, no rule, no reference, five lines, none); an unknown kind falls back; the moved
formatters pass the tests they had; `communityRuleLabel` equals `CommunityRules.label` for numbered, `uncovered`, unknown and retired.

**player-react.** `en` includes `NOTICE_WORDS` exactly; `NoticeCard`, `Facts`, `MyRecord` and `RestrictedChatLine` render the same DOM as
before (the existing suites stay green) and the same text as `noticeView`; a translation spread over `en` still wins; the size budget holds.

**Plan parity (core, against the real services).** A matrix of decisions (fair with each kind alone and in pairs; two people; warning
plus chat; note only; note plus warning; dismissal; bad faith with and without a sanction on the reporter; `reporterFeedback` on and off;
a retired and an `uncovered` rule; zero, one and five lines; with a rename), a direct sanction, a rename, a revoke, and the three
appeal outcomes including a reduction whose length has passed and a reduction to a warning: the plan's notices equal what
`cw.notices.pending` returns for each person: kind, order, rule label, end, excerpt text and day, acknowledge flag.
`appealReplacementEnd` is `min(original end, start + length)`, never later than the original.

**Rename (core, http).** `requireRename` without a numbered rule is `invalid`; `POST /people/:ref/rename` without `rule` is 400. `decide`
with `rename`: sanction and rename notices both written, order, audit rows (decision and `name.rename_required`), `rename.status`
`asked`; replay gives `already`; refusals before any write (400 with a non-`upheld` verdict, with an action on the reporter, without a
rule; 403 without `sanctions.apply`; 404 with renames off); a store fault in the rename step leaves the decision written and answers
`failed`; the claim gate runs once.

**Wire (http).** `noticeText` equals the text the real notice stores for the same line (delivered, blocked and starred, no spans, a
throwing matcher gives all stars); only own lines carry it; `GET /policy` carries `notices.reporterFeedback` from `cw.limits`;
no-leak and every-route suites pass.

**Decision bar (hub-react).** The rename row: absent with renames off or without `sanctions.apply`; shown at once for a `name` report,
behind the editor for others; cleared by a dismissal verdict with an announcement; its rule field is required and starts on the first
action's rule, then the report's; rename alone, plus a warning, plus a ban; the body sent (with `rename`) and nothing sent before the
hold ends; Undo sends nothing; each `rename` answer produces the right result line and keeps the decision; the headless controller does
the same without the shell. The off-hint: setting off with and without `policy.write`, on but unsupported, absent for other reasons and
for roles that cannot decide.

**The panel (hub-react).** For every action of 4.2: the notices, order, recipients, effects and nothing-sent lines of 4.3, for each
kind, a warning, a permanent ban, a timed restriction, lines present and absent, appeals on and off, reporter feedback on and off, two
people, a flagged name, a masked line. Live: it changes with every control (verdict, kind, length, line pick, rule, rename, lighter kind
and length) and recomputes its end time as the clock moves. Same output in Simple and Detailed. No interactive element inside it. A
sentinel scan: a reason, an evidence note, a gap note, an actor, a ref, a group id and an appeal statement placed in the form never
appear in the DOM or `aria` text. Axe: no violations, light and dark; 360 px: no sideways scroll. The hub size test holds; the panel
chunk is lazy.

**Parity of the two renderers (player-react's test directory, which already depends on hub-react and http).** For the same decision, the
panel's notice text equals the text of the notice the real `NoticeQueue` shows for the real server's `pending` answer.

**Appeal card.** The three outcomes are a radio group; nothing is sent until Send decision; the lighter picker drives the panel; the 0.1.9
refusal paths (`same_decider`, `already_decided`, `gone`) still keep the typed reason and settle the card.

## 10. Risks

- **Two implementations of "who gets which notice".** The service code and `planNotices` encode the same rules. The parity suite is the
  guard; it runs on every change to `decide.ts`, `nameService.ts`, `appealService.ts` or `notices.ts`.
- **Moving words and formatters out of player-react.** A refactor of the player's most-seen component. Mitigation: the move is
  mechanical, the existing player-react suites (notice queue, my record, layout, a11y, no-leak, size) are the safety net and run
  unchanged, and a DOM snapshot of every notice shape is taken before the move.
- **Appeal card behaviour changes** (three immediate buttons become a choice and a confirm): slightly slower, deliberately, because the
  moderator now sees what will be sent.
- **The AI never sees a name.** Its read of a `name` report is about the chat lines, which may be benign, so it may recommend "not a
  problem". The recommendation is a suggestion with its reasoning, and the panel now shows what a decision would send. Skipping the read
  for `name` reports is a follow-up.
- **Reporter not thanked after a rename-only decision.** The core's rule (a non-note sanction) predates renames. The panel says it.
- **The panel makes the dock taller.** On a phone the dock is a sheet that scrolls; the panel sits above the submit row inside it.
  Checked at 360 px in the hub tasks.

## 11. Not in this release

- A `previewWords` prop for the hub, so an adopter can preview its own translations.
- Hover or focus-driven previews of each one-tap button on Simple's card (each states its own effect instead).
- Telling the reporter when a decision only asks for a new name.
- Skipping the AI read for `name` reports; showing the name itself to the AI.
- A server-rendered preview route; previews in the Discord bot, Coop and EOS paths.
- Exporting the panel as a piece for adopters' own pages.
- Site copy: it flips a promise only after the release is on npm and has run in Moxgate.

## 12. Breaking changes, and the migration

**Migration 26 (the release's one migration): this change adds nothing.** No table, no column, no index.

**Breaking changes** (for the controller's release list):
1. `DEFAULT_REPORT_REASONS` has an 11th entry, `name`; anything that counted 10 default reasons changes.
2. `cw.names.requireRename` requires `rule` (a numbered, citable rule); `POST /people/:ref/rename` requires `rule`. Neither falls back to the
   slur filter's rule. Both hub forms require it.
3. `POST /reports/:id/decide` accepts `rename` and answers `rename`; `GET /reports/:id` excerpt lines carry `noticeText`; `GET /policy`
   carries `notices`. (Additive for readers; listed because clients are now expected to send and read them.)
4. The appeal card: three immediate buttons become a choice plus "Send decision".
5. Simple's `hub.simple.sees*` sentences are removed in favour of the panel; those catalog keys go.
6. player-react's `en` words and `titleKey`/`bodyKey`/`isSanction`/format helpers now come from `@chatwarden/core/notice-copy`;
   player-react and hub-react peer on a core that has the subpath (the controller sets the floors in the release prep), and `http` on a
   core with `cw.notices.lineText`. The player-react public exports are unchanged.
7. `CommunityRules.label` is implemented by `communityRuleLabel` (same output).

## 13. Rollout and docs

- Docs: core README (the subpath, `lineText`, the `name` reason, `rename` on decide, required rename rule), player-react README (the
  words now come from core), hub-react README (the panel, the rename row, the off-hint, the appeal choice), http README (the fields and
  the rename rule), `docs/status.md`, `docs/plans/follow-ups.md` (section 11).
- Rule for later: any change to a `NOTICE_WORDS` string or to `planNotices` is a visible change to players and preview together and goes
  in the changelog by name.
- `@experimental` on every new name (listed in the READMEs until 0.2 settles).
- Locked exports updated deliberately: hub-react `api.test.ts`/`apiNames.ts`, player-react `static.test.ts`, the core export snapshot and
  the new subpath's.
- Verify in a real browser at desktop and 360 px, light and dark, for the three hub tasks (CLAUDE.md UI rule).
- No release-prep task here: the controller does one for the whole of 0.2.0.

## 14. Rulings

### Owner rulings (2026-11-17, binding)
1. **A. Names.** The default reason `name`, "Inappropriate name", mapped to the rule that covers names; it joins `DEFAULT_REPORT_REASONS`.
   In the case decision "Ask for a new name" appears beside the usual choices when the report's reason is `name` or the moderator
   chooses it, can be combined with a sanction, and uses `cw.names.requireRename` / `names.renamesEnabled()`, `POST /people/:ref/rename`,
   the `rename.required` event, the `rename_required` notice and the claim rules. It stays behind `names.renames` (off by default); when
   off the hub shows a plain one-line hint saying so and where to turn it on (a link for the owner, words for others).
2. **B. The preview.** Every hub action that sends or withholds a notice gets one "What the player sees" panel; it renders the actual
   notice (title, body, rule, length or end, shown lines, the appeal button when appeals are on) live, in the kit's English words
   labelled "Shown in the player's language"; the words come from one source shared with player-react; when nothing is sent it says so
   in a plain line; it states other effects in one line; it sits under the decision bar, quiet, the same in Simple and Detailed.
3. **C.** Ships as one release. **Update:** that release is 0.2.0, with other themes; no users yet, so no compatibility paths; breaking
   changes are listed (section 12); all new tables and columns of the release go in migration 26 (this change has none); no release-prep
   task here; text chat only.

### Drafting rulings (2026-11-17, the drafter's; the owner may overturn any of them)
1. **Shared source is a core subpath, `@chatwarden/core/notice-copy`,** holding the words, `noticeView`, the formatters, the rule label
   and the pure plan (4.5). Chosen over hub-imports-player-react, a server preview route and copied strings.
2. **The preview is computed in the browser** by `planNotices`, kept honest by a parity suite, plus two required wire fields
   (`noticeText`, `notices.reporterFeedback`); no new route and no version gate.
3. **Rename in a case decision rides the decide request** (`rename: { rule }`), done by the server after the decision, with a gentle
   result when the rename step fails. No change to `DecisionService` or the decision's idempotency key.
4. **The panel sits directly above the submit row inside the dock** ("under the decision bar" read as below the choices, above the
   buttons), and replaces Simple's `hub.simple.sees` sentence. Simple's card previews its primary one-tap step.
5. **One-tap buttons that have no choice to reflect** (Nothing wrong here, the sweep) get one line, not a panel (4.3 B).
6. **The appeal card's three immediate buttons become a choice plus "Send decision"** so the panel reflects a current choice before
   anything is sent (4.3 G).
7. **A rename always cites a numbered rule** (core, http and hub), so the player is never told the hate rule by default and the preview
   is exact (3.4).
8. **The `name` reason is in group Chat, after `personal_info`, without a note field,** mapped to CR 7 only.
9. **The reporter is not thanked for a rename-only decision** (existing core rule); the panel says so; changing the rule is a follow-up.
10. **The AI is left alone for `name` reports** (follow-up); its recommendation stays a suggestion.
11. **The preview's English is final wording only where this note quotes it;** the hub catalog entries are proposals a review may polish.
