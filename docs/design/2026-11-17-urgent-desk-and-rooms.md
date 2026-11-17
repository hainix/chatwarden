---
status: proposal (design; no product code)
updated: 2026-11-17
release: 0.2.0 (one release, one branch, built in themed chunks; this document is two of its themes)
gaps: G3, G13, G14, G15 (the urgent lane and the desk); G6, G7, G8, G20 (rooms under attack)
---

# Urgent lane, a kinder desk, and rooms under attack (0.2.0)

Spec for two themes of 0.2.0, taken from `docs/design/2026-11-17-moderation-coverage-audit.md`. The plan is
`docs/plans/2026-11-17-urgent-desk-and-rooms.md` (tasks U1 to U12 and R1 to R6). Section numbers below are what the plan cites.

**Release context (owner, 2026-11-17).** Chatwarden has no users yet. The release is **0.2.0**, the point where `@experimental`
APIs settle, so this design carries no backward-compatibility constraint: no byte-identical-to-0.1.14 bodies, no upgrade shims,
no deprecation period. Where an existing API is clearly worse than the clean one, this design changes it and lists the change in
section 19 ("Breaking changes"). Chat is **text only**: images, media, avatars and voice are out of scope everywhere in this
document, and the kit never stores, fetches or previews them.

Other 0.2.0 themes are designed in parallel by others (names inside reports and the "what the player sees" preview; filter rules
and privacy; any server, many rooms and languages). This document does not design them. Section 17 lists what it needs from each.

## 1. Intent

A moderator's worst hours are not the busy ones. They are the ones where a threat waits behind forty spam reports, where a raid
floods a lobby faster than anyone can act, where a hard excerpt is on screen before the person is ready for it, and where nobody
can say how long the queue really waits. This release gives the desk six things, each small and each behind a door:

1. **An urgent lane.** A report about a threat (or, when the owner turns it on, a person who may be at risk) is seen first, by a
   person, and the game's own safety process hears about it at once, with no chat text in the message.
2. **A kinder desk.** A moderator can ask a senior to take a second look, escalate to the owner, and keep a short staff-only
   comment thread on a report; and can hide excerpts until opened, count what they have opened, and be offered a break.
3. **Insights.** Median time to a decision, the longest wait, the backlog by age, volume by reason and rule, the report rate per
   1,000 lines. Never a ranking of people.
4. **Rooms under attack.** Lock a room, take a delivered line back for everyone, and an emergency mode, all expiring on their own;
   new accounts can be held to slower chat; a report surge is named when it is happening.
5. **Linked accounts.** A staff-only line on a person: how many accounts and devices the kit has linked to them.
6. **A pointer to gameplay evidence.** A report carries an opaque match or replay id and the case shows a link built from the
   game's own template.

## 2. Goals and non-goals

**Goals.**
- Urgent reports are never behind ordinary ones in take-next or in the queue, never swept away by a bulk dismissal, and never
  a reason to suspend the reporter.
- The kit routes and surfaces. It gives moderators guidance text and shows adopter-configured resources. It decides nothing about
  risk.
- Every new switch is off until an owner turns it on. The one exception is the urgent chip, which exists only while something
  urgent is open.
- The core screen stays clean. Everything advanced sits behind an existing door: Settings, Advanced, a `...` menu on the case, the
  Person page's `...` menu, and the existing Filters drawer.
- Test-first and small: no new always-visible control except the urgent chip.

**Non-goals.** Stated plainly, because the first four are where a safety feature goes wrong:
- The kit **does not diagnose** anyone, rate risk, judge whether a threat is credible, or decide that a line is a crime.
- The kit **does not contact anyone**: not the person who may be at risk, not the reporter beyond the thank-you the game
  configured, not police, a crisis service, NCMEC or a regulator. It emits ids-only events; what happens next is the game's.
- The kit **never forwards CSAM**, and holds none. It stores text only; it fetches, resolves and previews no link or image; no
  event, webhook or Discord post carries a chat line unless the adopter opted in and signed the endpoint. Detection and reporting of
  child sexual abuse material go through the adopter's own legal process and tools such as Coop and HMA.
- No pager. The kit does not wake anyone. For round-the-clock cover, route `report.created` with `urgent: true` into the game's own
  on-call tool.
- No leaderboard, exposure score or speed number per moderator, ever.
- No new sanction type, no automatic sanction from a room mode, a probation rule or a surge. A person decides.
- No second approval gate: an escalation asks, it does not block the moderator from deciding.
- No per-room tag scoping of staff, no per-context profile (the many-rooms theme).
- No detection of VPNs, no linking of people by IP address, no fingerprinting. The linked-accounts view only counts what the
  subject graph already links.

## 3. What the kit does and does not do for safety (the text a moderator and an adopter read)

This section is the source of the copy in the hub's "What to do" panel and of the adopter guide (plan task U12).

**The kit does:** mark a report urgent from its reason (or by a moderator), sort it first, show one chip while any is open, post a
role mention in the Discord feed if the owner set one, emit `report.created` with `urgent: true` (ids and the reason id only),
show the moderator the game's own guidance and studio contact text, show the reporter the game's own thank-you and resource list,
record when a moderator marked the case as passed to the game's safety team, and keep welfare reports for a shorter time.

**The kit does not:** decide whether anyone is at risk or a threat is real; message the person reported or anyone else; ring,
email or post anywhere by itself except the staff channels the adopter wired; report to any authority; store, copy, fetch or
forward images, links' targets or media; promise a response time.

**The default guidance** (English; the owner may replace it, section 5.3) is four short paragraphs: (1) you are not asked to judge
risk, only to pass it on quickly through your studio's process; (2) here is how to reach it (the owner's contact line, or "ask the
owner to add one in Settings"); (3) do not contact the player yourself from a personal account and do not copy the chat anywhere
outside the hub; (4) if anything involves a child in danger or sexual material involving minors, stop, do not save, copy or forward
it, and follow your studio's legal procedure. The default is a safe floor, not legal advice, and says so in the Settings panel.

## 4. Settings

New and changed profile sections. All are optional input; every default below is what an unset profile means. The sections follow
`POLICY_SECTIONS` order by appending (`desk`, `safety`, `rooms`), and are editable by the owner in the existing stored layer like
the others. Validation errors are `ProfileError` with the path and never echo the value.

| Path | Meaning | Default |
| --- | --- | --- |
| `reporting.reasons[].urgent` | Reports filed under this reason are urgent. A snapshot taken at filing. | `threat`: true; every other reason: false |
| `reporting.reasons[].thanks` | What the reporter is told after sending a report under this reason (at most 300 characters). Absent: `reporting.thanks`. | absent |
| `reporting.reasons[].showResources` | Show `safety.resources` after the thank-you for this reason. | `welfare`: true; others false |
| default reason `welfare` | Id `welfare`, label "Someone may be in trouble", hint "Someone who says they want to hurt themselves, or may be at risk", group Chat, no rule, asks for a note, **disabled**, urgent, showResources. | disabled |
| `safety.guidance` | Text moderators read in the "What to do" panel (at most 1500 characters, blank lines separate paragraphs, plain text). | the default in section 3 |
| `safety.contact` | One line for staff only: who to reach in the studio (at most 300 characters). Never sent to a player. | empty |
| `safety.resources` | Up to 5 `{ label (60), detail (200), url? (https only) }` shown to the reporter after a report whose reason has `showResources`. A game puts its crisis line and safety page here. | none |
| `desk.workflow` | Staff comments and "ask for a look". Off: the routes answer 404 and the hub shows nothing of them. | false |
| `desk.insights` | The Insights page and the line counter that feeds the report rate. | false |
| `desk.surge` | `{ enabled, reports (3 to 100), windowMinutes (1 to 120), newAccountDays (1 to 30) }`: name a report surge on a case. | `enabled` false, 5, 10, 2 |
| `reporting.evidenceUrl` | `https://` template with exactly one `{ref}` placeholder, for the case's evidence link. | unset |
| `rooms.defaultModeMs` | How long a lock or emergency lasts when the caller names no length, ms (60 000 to 86 400 000). | 1 800 000 (30 minutes) |
| `rooms.emergency` | `{ slowModeMs (1 000 to 600 000), newAccountDays (0 to 30; 0 = off) }`: what emergency mode adds. | 30 000 and 7 |
| `rooms.probation` | `{ enabled, ageDays (1 to 30), slowModeMs (500 to 600 000) }`: new accounts chat slower. | `enabled` false, 2, 5 000 |
| `rooms.unknownAge` | What an account with no known age is treated as by probation and emergency: `allow` or `treat_as_new`. | `allow` |
| `retention.welfareReportsMs` | Reports whose reason is `welfare` are deleted after this long (floor 1 day). | 30 days |
| `retention.chatCountsMs` | Daily line counts (section 9). Floor 31 days. | 400 days |

`reporting.evidenceUrl` is validated like the appeal URL: `https` only, a host, one `{ref}`, at most 300 characters, no credentials.
The links in `safety.resources` follow the same rule and are rendered with `rel="noopener noreferrer"`; a non-https url is a
`ProfileError`.

## 5. The urgent lane (G3)

### 5.1 What urgent means

A report is **urgent** when its reason is flagged `urgent` at the moment it is filed, or when a moderator marks it. `urgent` is
stored on the report (a snapshot): editing a reason later does not change reports already filed. Only two things set it: the
reason flag, and a moderator (`POST /reports/:id/urgent`, any moderator, both directions, audited). The AI never sets, clears or
reads it as an instruction: the existing AI severity chip stays advice only. A report a filter filed with no reporter is urgent
only if the rule that filed it said so (section 17, the filter theme).

An urgent report is "open" until it is decided; a case (a person) is urgent while any of its open reports is.

### 5.2 Behaviour

- **Take next** (`cw.cases.next`) looks for an urgent case first, under the caller's category and reason filters, and ignores the
  habitual-reporter rank-down and the signal boost for that pass: a threat from a habitual false reporter is still read. An urgent
  case another moderator holds is skipped, like any held case (urgent never overrides a claim). When none is free, the ordinary scan
  runs unchanged. With no urgent report open, take next behaves exactly as it does without this feature.
- **The queue** pins urgent cases to the top in every sort the hub offers. The server list `GET /reports` stays newest first; the
  hub gets the urgent ones from `GET /reports?status=open&urgent=1` (so an old urgent report is found even when the queue's pages
  have not reached it) and from the count in `GET /changes`.
- **One chip**, in the queue pane's header and above Simple's Cases list, that exists only while the count is above zero: the word
  "Urgent", the count, and the oldest wait ("2 urgent, oldest 14 min"). It is one button that opens the oldest free urgent case. No
  colour carries it; the words do.
- **A row word.** Each urgent row carries the existing `Tag` with the word "Urgent" (not colour alone).
- **A case strip.** An urgent case shows one line at the top, "Urgent: <reason label>", and a collapsed-or-open "What to do" panel
  (5.3). Open by default until the moderator collapses it (kept in the browser).
- **A bulk dismissal ("nothing wrong here" by person or reporter) never closes an urgent report.** It skips it and counts it in
  `skipped.urgent`. A single dismissal is allowed: it is a person reading the report.
- **A `bad_faith` verdict is refused on a `welfare` report** (`invalid`), and a decided `welfare` report is excluded from the
  reporter's accuracy numbers and from the habitual-reporter ranking. A reporter is never suspended for reporting a person who may
  be at risk.
- **A welfare report closes without a rule.** The verdict is `noted` or `no_action`; it never creates a rule-gap row.
- **Hand-off mark.** "I passed this to our safety team" (`POST /reports/:id/handoff`, any moderator, claim-gated like a decision)
  records who and when on the report, writes an audit row, and emits `report.handoff` (report id and time only). It is a note for
  colleagues and for the game's own process. It contacts no one. Clicking it twice is a no-op that keeps the first time.
- **Events.** `report.created` gains `urgent: boolean`. The Discord feed can mention a role for an urgent post
  (`urgentMention`, a role id the owner sets in the feed options). An urgent Discord post says "Urgent report. Open in the hub." and
  never names the reason when it is `welfare`.
- **Retention.** A `welfare` report (its excerpt, note, comments and decision row) is deleted after `retention.welfareReportsMs`
  (default 30 days), earlier than the 90-day default for other reports, because it is the most sensitive text the kit holds. A
  report the privacy theme holds for legal reasons is skipped (section 17).
- **The reporter** sees, after sending, the reason's `thanks` (or the global thank-you) and, when the reason has `showResources`,
  the owner's resource list. The dialog never says the kit has alerted anyone.
- **The person reported** is told nothing by the kit. No notice, no message, no restriction follows from a report, urgent or not.

### 5.3 The "What to do" panel

Read-only for staff, from the profile: `safety.guidance` paragraphs (or the default), `safety.contact` when set, then two buttons
("I passed this to our safety team" and "Mark as not urgent"), then one plain line of the kit's limits: "Chatwarden does not judge
risk, contact anyone or forward images. It holds text only." Everything is a `t()` key except the owner's own text. The panel is
labelled and reachable by keyboard (a disclosure button with `aria-expanded`).

## 6. Staff workflow: comments, a second look, escalation (G13)

All behind `desk.workflow` (off: 404 and no hub trace).

- **Comments.** A staff-only thread on a report: author (staff id), role, time, up to 500 characters. Trimmed, control, bidi and
  zero-width characters removed, rendered as plain text. At most 50 per report. A moderator may remove their own comment; a senior
  may remove any. No editing. Comments are never in an event, a webhook, a Discord post, a notice, an audit row, an AI prompt, a log
  line or any player-facing body. They are deleted with their report. The panel states: "Do not paste chat here."
- **Ask for a look / escalate.** `POST /reports/:id/escalate { to: 'senior' | 'owner', note? }`. The report is marked
  `escalatedTo` with who and when; a note (optional, same rules as a comment) is added to the thread. It does not change the claim,
  does not block anyone from deciding, and is cleared when the report is decided, or by "Looked at" (`DELETE /reports/:id/escalate`,
  the asker or anyone at or above the target). A moderator may ask a senior or the owner; a senior may ask the owner or another
  senior. Wording in the hub: "Ask a senior to look" and "Escalate to the owner".
- **Where it shows.** On the case: a line "Asked for a look by <staff name>, <time>" and the thread. In the queue: one word on the
  row ("Asked for a look") and one option in the existing Filters drawer ("Asked for a look") that lists only those addressed to the
  caller's role or lower. On Overview: one line "N cases waiting for a senior look" when workflow is on, the caller's role may act on
  some, and N is above zero. Escalation does **not** reorder the queue or take-next.
- Comments and escalation are never claim-gated: a senior can reply without taking the case.

## 7. Careful view (G14)

A personal, browser-only setting: nothing is sent to the server, nothing is stored on it, and an owner cannot see it.

- **Hide excerpts until I open them.** When on, the transcript, the reporter's note, the AI's summary and lines, and an appeal
  statement are replaced by one button, "Show the chat (12 lines)", until the moderator opens them. Opening applies to the whole
  case for the rest of the visit. The text is **not rendered at all** while hidden (not merely blurred), so a screen reader does not
  read it either. This is care, not protection: the server still sends the same body, and the hub says so in one sentence in the
  setting's help.
- **Count what I opened.** Optional. A counter of excerpts opened today (the browser's local date), shown only in the setting.
- **Offer a break.** Optional: after N excerpts opened in a day (10, 25, 50; default off) the hub shows one dismissible, non-modal
  line in the case, "You have opened N excerpts today. A short break may help.", and again at each further N. It never blocks.
- Where: Settings, Advanced, a first panel "Your own view" that needs no server data (a person can set it without `policy.read`
  data loading), and one command-bar entry to toggle hiding. Storage is `localStorage` in a `try/catch`; when it fails the setting
  lasts for the visit. There is no default-on in any mode, including for urgent cases.

## 8. Insights (G15)

Behind `desk.insights`. `GET /insights?days=7|30|90` (default 30; `insights.read`, moderator). Everything is computed from rows the
kit already holds, plus one daily line counter (section 13) for the rate.

```
{ days, from, to,
  reports:   { filed, decided, open },
  decision:  { decided, medianMs, p90Ms },            // medianMs and p90Ms are null below 5 decided reports
  urgent:    { filed, decided, medianMs },            // medianMs null below 3
  wait:      { longestOpenMs, backlog: { under1h, under4h, under1d, under3d, over3d } },
  byReason:  [{ reason, label, count }],              // by the reason the reporter gave, "none" included, newest-first by count
  byOutcome: { actioned, dismissed, badFaith },
  byRule:    [{ rule, count }],                       // sanctions written in the window, by Community Rule, "uncovered" last
  chat:      { delivered, refused, reportsPer1000 } | null,   // null when counting was off for the whole window
  partial:   boolean }                                // true when the read hit its row cap (20 000 reports)
```

- Time to a decision is `actionedAt - createdAt` of reports filed in the window and decided. It shows the median and the 90th
  percentile of the team, **never a per-person number**: `actionedBy` never leaves the server in this route.
- The page shows the median and the longest wait together on purpose: a median alone invites speed over care.
- `reportsPer1000` is reports filed in the window per 1,000 delivered lines, or null when delivered is 0.
- The page is under the Overview's own link ("Insights", shown only when the feature is on and the caller can read) and the command
  bar, not a new rail item. It has no export in 0.2.0.
- **Digest.** `cw.insights.digest(days = 7)` returns the compact numbers (counts and times, no names). `feed.postDigest()` in
  `@chatwarden/discord` posts them to the staff channel, and a webhook endpoint may subscribe to `insights.digest`, raised by
  `cw.insights.emitDigest()`. The kit has no scheduler: the adopter calls it from their own timer or cron (a recipe shows both).

## 9. Rooms under attack (G6)

### 9.1 Modes

`cw.rooms.setMode(roomId, mode, opts?)` with `mode` one of `normal`, `locked`, `emergency`.

- **locked.** A line from anyone except a staff member is refused with reason `locked` (and `until`). Whether a member is staff is
  the game's word: `ChatMember.staff: true` from the `join` hook, or `accept(..., { staff: true })` on the facade. A locked room
  keeps delivering history and keeps mute and report working.
- **emergency.** Slow mode `rooms.emergency.slowModeMs` (the stricter of it and the room's own pace), and accounts younger than
  `rooms.emergency.newAccountDays` are read-only (refused `new_account`, with `until`). "Links off" is the filter theme's built-in
  (section 17).
- **Expiry.** Every non-normal mode expires: `opts.forMs` (60 s to 24 h) or `rooms.defaultModeMs`. There is no "until I turn it
  off". Setting a mode again replaces the earlier one whole, and restarts the clock. `normal` clears at once.
- **Per process, in memory,** like pace (documented). A game with several processes calls it in each, or sets it from the hub of
  the process serving that room. `rooms.close(roomId)` clears it.
- **Order in `accept`.** Empty, length, then the person's own restriction (they are told their own restriction first), then
  `locked` and `new_account`, then the matcher, then pace. A line refused for the mode is never matched, so it earns no strike and
  no automatic timeout.
- `cw.rooms.mode(roomId)` reads `{ mode, since, until }` (expiry applied lazily, announcing `room.mode` with `expired: true` when
  it notices). `cw.rooms.list()` returns up to 500 rooms the process knows (seated players, or a mode set): `{ roomId, tags,
  seated, mode, until }`, no seat ids, no handles. `cw.rooms.postingState(roomId, seatId)` returns `'ok' | 'locked' |
  'new_account'` for the chat box's hello, a pure read.
- `room.mode` is raised on every change (by whom is in the audit row, not the event).

### 9.2 Taking a line back

`cw.rooms.retract(roomId, lineId, opts?)`: marks a delivered line removed **for everyone**, keeping it as evidence. With
`opts.allFromAuthor: true` it also removes every line still in the evidence window by the same seat's occupant (the spam-wave
case). It works only while the line is in the evidence buffer (15 minutes, 100 lines per room), otherwise `not_found`.

- The evidence line gets `retracted: true`. The excerpts of reports filed afterwards carry it, and the hub transcript marks the
  line "Removed from the room". A line already inside a stored report excerpt is not rewritten.
- The kit raises `line.retracted { roomId, lineIds, at }`. The room broadcaster listens (`cw.on`) and sends a `retract` frame to
  every stream, drops the text from its history ring, and a game using its own socket listens to the same event. No direct call
  from the staff routes to the broadcaster is needed.
- **Not a sanction.** A retraction says nothing to the author, creates no notice and no strike. If the line also deserves one, the
  moderator decides the case as usual.
- A report on a retracted line is still valid (the reporter may have seen it before it went).

### 9.3 Probation for new accounts (G7)

Behind `rooms.probation.enabled`. A player whose account age is below `ageDays` (from the existing `signals.accountAgeDays` hook)
is paced at least `slowModeMs` between lines in every room, whatever the room's own pace says (the stricter wins). The refusal
is `probation` with `retryAfterMs`. It is a pause, not a sanction: no rule, no notice, no strike, no audit, no record; it is not
shown on "My record". The age is cached per person for 10 minutes. With no hook, or an age the hook cannot tell, `rooms.unknownAge`
decides (`allow` by default: the kit does not slow down people it cannot place). Probation never touches links (the filter theme's
link rule has its own account-age setting).

### 9.4 The report-surge chip (G7)

Behind `desk.surge.enabled`. On a case (`GET /reports/:id`), when the person has at least `reports` open or recent reports
inside `windowMinutes`, the body carries `surge: { reports, reporters, windowMinutes, newAccounts: number | null, newAccountDays }`
and the hub shows one line on that case: "12 reports in 10 minutes from 12 players, 10 of them accounts under 2 days old." with the
hint "A hint, not a reason to set reports aside." `newAccounts` is null when no age hook exists. It is computed on read from
existing rows (capped at 200 reports and 100 reporters), appears nowhere else, changes no order, never refuses or discounts a
report, and is never an event. A report from a new account is as valid as any.

## 10. Linked accounts (G8)

`GET /people/:ref/links` (`history.read`, audited as `history.view`): `{ accounts, devices, merged, firstLinkedAt?, inForceOnLinked }`
counts only: how many account ids and client keys the kit has linked to this person, how many other subjects were merged into
them, and how many sanctions in force were placed on a merged subject rather than the person's own record (by kind). **No ids, no
keys, no IPs, no hashes** are returned and IP is never counted. The Person page shows one line behind its `...` menu ("Linked
accounts"): "3 accounts and 2 devices are linked to this person. 1 ban in force was placed on a linked account." with the hint "A
shared device can link two different people. This is a hint, not proof." Nothing else changes: the door already refuses a new
account that is linked to a banned person with the ban's own refCode (`doors.check` follows merges), and this task adds a test that
pins it. There is no unlink in 0.2.0.

## 11. Evidence pointer (G20)

`ReportInput.evidenceRef`: an opaque string, 1 to 128 characters of `[A-Za-z0-9_:-]` (no dot, no slash), supplied **by the game's
server** only. It comes from `cw.reports.submit`'s caller or `ChatMember.evidenceRef` in the `join` hook (so a chat-box report
carries it); the chat route never reads it from a request body. An invalid value is dropped (the report is still taken) and logged by
class. `GET /reports/:id` returns `evidence: { ref, url }` where `url` is the owner's `reporting.evidenceUrl` with `{ref}` replaced
by `encodeURIComponent(ref)` (https only, checked again at read), or `url: null` with no template. The case shows one row
"Match or replay: <ref>" with a link when there is a url. The ref is not in events, the queue summary, webhooks or Discord.

## 12. Wire changes

### 12.1 Chat wire (version 2)

`CHAT_WIRE_VERSION` goes from 1 to 2 (section 19). `hello` gains `mode: { kind, until }` and `you.readOnly?: 'locked' | 'new_account'`.
New frames: `{ type: 'mode', mode: { kind, until }, readOnly?: 'locked' | 'new_account' }` (per viewer, since read-only depends on
the account) and `{ type: 'retract', ids: string[] }`. `WireRefusal.reason` documents `locked`, `new_account` (with `until`, the
mode's end) and `probation` (with `retryAfterMs`). `RefuseReason` gains `locked` and `new_account`; `PaceReason` gains `probation`.
The broadcaster sends a `mode` frame on `room.mode` and at expiry (its own `schedule`), and a `retract` frame on `line.retracted`.
The player's chat box (player-react) shows one line above the composer while the mode is not normal ("Chat is locked until
14:30" / "Slow mode is on. New accounts can only read."), disables the composer for a read-only viewer with that same line as its
accessible description, and replaces a retracted line with "Message removed by a moderator" (the text is dropped from client
state). Mode and retract announcements go through the existing polite live region, once per change.

### 12.2 Staff routes

| Route | Permission | Audit | Notes |
| --- | --- | --- | --- |
| `GET /reports?urgent=1` | `reports.read` | existing | open urgent reports as summaries (`urgent`, `escalatedTo?`, `handoffAt?` added to each summary) |
| `GET /changes` | `reports.read` | none | gains `urgent: n` and, with workflow on, `asked: n` |
| `POST /reports/:id/urgent { on }` | `reports.urgent` (moderator) | `report.urgent` best-effort | |
| `POST /reports/:id/handoff` | `reports.handoff` (moderator), claim gate | `report.handoff` best-effort | idempotent |
| `GET /reports/:id` | `reports.read` | existing | gains `urgent`, `handoff`, `escalation`, `comments` (workflow on), `surge`, `evidence` |
| `POST /reports/:id/comments { text }` | `reports.comment` (moderator) | `report.comment` best-effort | 404 when workflow off |
| `DELETE /reports/:id/comments/:cid` | `reports.comment` | `report.comment_remove` | author, or senior |
| `POST /reports/:id/escalate { to, note? }`, `DELETE ...` | `reports.escalate` (moderator) | `report.escalate` | |
| `GET /insights?days` | `insights.read` (moderator) | `insights.view` best-effort | 404 when off |
| `GET /rooms` | `rooms.read` (moderator) | none | list of 9.1 |
| `POST /rooms/:room/mode { mode, forMs? }` | `rooms.manage` (moderator) | `room.mode` required | the audit write happens first for a lock |
| `POST /rooms/:room/lines/:line/retract { allFromAuthor? }` | `rooms.manage` | `room.retract` required | |
| `GET /people/:ref/links` | `history.read` | `history.view` | counts only |

`rooms.manage` and the other moderator-level defaults can be raised with the existing `permissions` option. A `:room` param is
percent-decoded and length-checked; a room id that is not a valid audit ref is audited by a keyed hash (`h-` and 16 hex), and the
audit target type `room` is new.

### 12.3 Events and the audit trail

Events (appended): `report.handoff { reportId, at }`, `case.escalated { reportId, to, at }` (named so it cannot collide with the
privacy theme's `report.escalated`, section 17), `room.mode { roomId, mode, until, expired? , at }`, `line.retracted { roomId, lineIds,
at }`, `insights.digest { ... }`. `report.created` gains `urgent`. None carries text, a handle, a staff note or a reason. Audit
actions appended: `report.urgent`, `report.handoff`, `report.comment`, `report.comment_remove`, `report.escalate`, `room.mode`,
`room.retract`, `insights.view`. Target type appended: `room`.

## 13. Data: migration 26

One new SQLite migration for the whole release. This theme adds, and only this:

- `kit_reports.urgent INTEGER NOT NULL DEFAULT 0`, and a partial index `kit_reports_urgent_open` on `(created_at, id)`
  `WHERE urgent = 1 AND status = 'open'`.
- `kit_reports.handoff_at INTEGER` and `kit_reports.handoff_by TEXT`.
- `kit_reports.escalated_to TEXT CHECK (escalated_to IN ('senior','owner'))`, `escalated_by TEXT`, `escalated_at INTEGER`.
- `kit_reports.evidence_ref TEXT`.
- table `kit_report_comments (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment','ask','escalate','clear')), text TEXT)` and index `(report_id, at, id)`.
- table `kit_chat_days (day TEXT PRIMARY KEY, delivered INTEGER NOT NULL, refused INTEGER NOT NULL)`.

Because the release is the first one with users, no backfill and no table rebuild is needed (old rows read `urgent = 0`). Memory
store: the same through optional store methods and one shared contract suite. Staff ids (`handoff_by`, `escalated_by`,
`kit_report_comments.actor`) are staff, not players; no subject id is added anywhere by this theme.

## 14. Edge cases

- **An urgent report about a person already held** by another moderator: it waits for that moderator or a take-over (senior). The
  chip still counts it, and Overview shows "held by <name>". Urgent never steals a claim.
- **A threat and a bulk dismiss at once.** The dismiss skips it (`skipped.urgent`); the confirm dialog says "N urgent reports were
  left open".
- **A reason's urgent flag turned off** while reports are open: those stay urgent (snapshot) until decided or cleared by a moderator.
- **Welfare reason turned off** while reports are open: they stay visible, as any switched-off reason's reports do.
- **A moderator marks urgent a report that is already decided:** `closed`, nothing changes.
- **Urgent report from a suspended reporter:** reports from a suspended reporter are refused as today; the refusal body for an
  urgent reason adds nothing new. (The reporter can still use the game's own safety route; the dialog's refusal words point to it
  when `safety.resources` exist.)
- **Clock skew and expiry.** Mode expiry uses the injected clock. A mode whose `until` has passed reads as normal on the very next
  `accept`, even if the broadcaster's timer is late; the `mode` frame follows.
- **A restart** forgets modes, as it forgets pace overrides (documented). A game that wants a mode to survive sets it again from
  its own start-up.
- **Locked room and a staff member's `staff` flag** is the game's claim; a game that sets it for everyone has no lock. Documented.
- **Retract of a line in a report's excerpt:** the excerpt keeps the text (evidence); only new excerpts carry the flag.
- **Retract on a line by a seat that changed hands:** `allFromAuthor` follows the occupant at the time of each line (the evidence
  buffer's occupant), not the seat's current one.
- **Probation and a player with several accounts:** the kit passes all of the person's account ids to the `accountAgeDays` hook and
  uses its answer as is; the hook's documentation says to answer the **oldest** age, so a veteran on a fresh alt is not slowed. A
  person with no account and no answer is `unknownAge`.
- **Comments on a report that is purged:** deleted with it, in one transaction.
- **Hostile text in a comment or in `safety.guidance`:** rendered as text, never as markup; bidi and zero-width characters stripped;
  a lone surrogate and NUL removed; length counted in code points.
- **Insights with no reports:** zeros and nulls, never NaN; counters off for part of the window: `chat` null when counting began
  inside the window, and the page says "counted from <date>".
- **`rooms.list()` in a busy process:** capped at 500, most seated first; the hub says so when capped.
- **Two moderators change one room's mode at once:** last write wins; both get a `room.mode` event and an audit row.

## 15. Privacy

- Welfare is the most sensitive report: shorter retention (30 days), every read audited like any evidence, the Discord post and any
  Discord thread never name it, no AI read feeds anything outward, and no comment, note or excerpt is in any event.
- Staff comments are free text that moderators may misuse. The README and the panel warn; they are staff-only, purged with the
  report, and never read by the AI.
- Careful view and its counter live only in the browser. A counter of what a moderator opened is a form of tracking; it is never
  sent and the owner cannot read it.
- Insights are team aggregates. No per-moderator figure, no name, no subject id.
- Linked accounts returns counts, never identifiers. IP addresses are not read.
- The evidence ref is opaque and supplied by the game; the url is the game's host. The kit never fetches it.
- `kit_chat_days` holds a date and two counts: no player data. Counting runs only when `desk.insights` is on.
- Room ids and tags appear in the staff hub and in `room.mode` events; they are the game's identifiers, not player text.
- Erasure interaction (the privacy theme): comments and handoff fields hold staff ids only; deleting a report deletes its comments.

## 16. Accessibility

- Every new control is a real button or link with a visible label; no icon-only control without an `aria-label`.
- The urgent chip is a button. A new urgent report is announced once, politely, "An urgent report arrived", on the transition
  from none to some or on an increase, never on every poll, never assertively.
- Urgent is shown in words ("Urgent"), not colour. No new colour anywhere; bands and states are words.
- The "What to do" panel and the `...` case menu are disclosure buttons (`aria-expanded`, `aria-controls`), keyboard operable, with
  Escape closing and returning focus to the button.
- Careful view removes hidden text from the DOM, so a screen reader cannot read what a sighted moderator has chosen not to see; the
  opening button says how many lines it holds. No motion; `prefers-reduced-motion` is respected by default because nothing animates.
- The break reminder is `role="status"`, non-modal, and dismissable by keyboard.
- The chat box's mode line is the composer's accessible description; the disabled composer is `aria-disabled` with the same text
  (not removed from the tab order, so a keyboard user learns why). Mode and retract changes use the existing polite live region once
  per change; a retracted message is replaced in place and does not take focus.
- The Rooms panel's mode control is a labelled radio group; the duration choice is a labelled select; switching back to normal needs
  no confirmation. 360 px layouts have no sideways scroll; checked with axe in light and dark.
- Insights tables have header cells and captions; there are no charts, so nothing relies on colour or hover.

## 17. Interfaces needed from the other 0.2.0 themes

**Names in reports and "what the player sees" preview.**
- The preview of the reporting settings must render a reason's player view from `PlayerReporting` as the server returns it (this
  theme adds `thanks`, `showResources` per reason and `resources` at the top), not from a hard-coded copy, so the thank-you and the
  resource list are previewed for free.
- A name that appears in an urgent chip, a case strip, a comment thread author line, the surge line or the Rooms panel goes through
  the hub's `displayName` (their masking). Comment authors are staff and are not masked.

**Filter rules and privacy.**
- *Filters:* the chat check passes `{ roomMode, probation }` into rule evaluation, so a built-in rule can refuse links in
  `emergency` and a link rule can use its own account age. Emergency's "links off" is theirs to provide; if it is absent the
  emergency mode is slow mode and read-only new accounts only. A `flag` filter action files a system report; `urgent` is false for it
  unless the rule says `urgent: true`, and this theme's intake accepts `urgent` from that internal caller only (never from a player
  body). Their refusal reasons must not collide with `locked`, `new_account` and `probation`.
- *Privacy:* the purge (including my earlier `welfare` purge) must skip a report held for legal reasons. The erase contract test
  enumerates tables with a subject id: this theme adds none, but `kit_reports.evidence_ref` is an opaque game id and
  `kit_report_comments` holds staff text, and both go when the report goes. Their event for a legal hold is named `report.escalated`;
  mine is `case.escalated`. Please keep them apart.

**Any server, many rooms, languages.**
- *Many rooms:* `cw.rooms.list()`, the urgent queries and the insights reads go through store methods that can take a scope later; if
  staff scoping by room tag lands, those reads must apply it in the store, and `GET /rooms` must show only scoped rooms. Per-context
  profiles would give `rooms.probation` and `rooms.emergency` per context; this design reads them from the resolved profile for the
  room, so a context merge needs no change here.
- *Service mode:* the chat wire version 2 frames (`mode`, `retract`) and the three new refusal reasons are part of the HTTP contract
  a non-Node server relays, and room modes are in memory per process, so a service-mode deployment sets them in the process that
  holds the room (one process per room, as already documented).
- *Languages:* every new player word (`enChat`: locked line, read-only line, probation, removed message; the thank-you screen's
  resource heading) and hub word is a key with an English catalogue, so their translation tests pick them up. The owner's
  `safety.*` text and per-reason `thanks` are the game's own language and are not translated by the kit.

## 18. Words (summary)

Player (`player-react`): chat `chat.locked` ("Chat is locked until {time}."), `chat.readOnlyNew` ("New accounts can only read right
now."), `chat.probation` ("New accounts chat a little slower for now. Try again in {seconds} seconds."), `chat.removed` ("Message
removed by a moderator."), `chat.modeEmergency` ("Slow mode is on."), report thank-you resource heading `report.resources`
("If you or someone else needs help"). Hub: `hub.urgent.*`, `hub.safety.*`, `hub.desk.*`, `hub.insights.*`, `hub.rooms.*`,
`hub.person.links.*`, `hub.case.surge`, `hub.case.evidence`, `hub.care.*`. Every string goes through `t()`.

## 19. Breaking changes

None is a compatibility shim; each is the clean form.

1. `CHAT_WIRE_VERSION` 1 to 2: `hello.mode`, `you.readOnly`, the `mode` and `retract` frames. A v1 client refuses a v2 server and the
   reverse. The chat box and the broadcaster ship in lockstep.
2. `RefuseReason` and `WireRefusal.reason` gain `locked` and `new_account`; `PACE_REASONS` gains `probation`. An adopter switch with
   `assertNever` must handle them.
3. `report.created`: `urgent: boolean` added, and `reportedReason` becomes required (`string | null`); the 0.1.1-era optionality is
   removed. `StoredReport` gains required `urgent` and `evidenceRef`; `ReportRecord.reportedReason` and `detailAt` become required.
   A custom `Store` must supply them.
4. `ResolvedReporting.reasons[]` gains `urgent`, `thanks`, `showResources`; `PlayerReporting` gains per-reason `thanks`,
   `showResources` and a top-level `resources`. The default reasons gain a disabled `welfare`, and **`threat` is now urgent by
   default**: the one behaviour change that is on out of the box (take-next and the queue put it first).
5. `cases.next` with an urgent report open returns it first (no flag); `dismissMany` results' `skipped` gains `urgent`.
6. `ReportExcerptLine` and `EvidenceLine` gain optional `retracted`.
7. `ChatMember` gains optional `staff` and `evidenceRef`; `cw.chat.accept` options gain `staff`.
8. `AUDIT_ACTIONS`, `AUDIT_TARGET_TYPES`, `KIT_EVENT_TYPES`, `PERMISSION_KEYS` and `POLICY_SECTIONS` are append-only and gain the
   entries in this document; the order-lock tests are updated by append.
9. Hub `PermissionKey` and the `GET /me` `can` list gain the new keys; `GET /changes` gains `urgent` (and `asked`).

## 20. Rulings

Decisions this design took that were not given in the brief. Each is open to the owner.

1. **Urgent is a stored snapshot, not a live lookup of the reason.** Cheap, indexable, and a settings edit cannot reorder a queue
   under a moderator. Cost: one column and a partial index.
2. **A moderator can raise or lower urgent on a report** (any moderator, audited). The audit asked only for the reason flag; a reporter
   who files "harassment" over a line that reads as a threat should not need a rule edit.
3. **The AI never sets urgent.** The audit allowed raising "only through the existing severity field". This design drops that: the AI
   read stays advice, and the existing severity chip and priority sort already carry it.
4. **Urgent ignores rank-down and signal boost, but not claims.**
5. **Bulk dismissal skips urgent reports; `bad_faith` is refused and reporter stats are untouched for `welfare`.** A person who
   reports someone at risk is never penalised.
6. **The person reported is told nothing, ever.** The audit's "the person in crisis is shown the game's help text" is not built: it
   would tell a player they have been reported as at risk, a diagnosis by another name. The game's own flow, fed by the event, may
   do it. The reporter's thank-you and resources are built.
7. **Hand-off is a mark, not an action.** It contacts no one, works with workflow off, emits an ids-only event.
8. **Welfare reports are kept 30 days**, not the 90 of other reports.
9. **Escalation does not reorder the queue or block anyone.** It is a flag, a thread entry, a filter and one Overview line. A
   second approval workflow would turn a kindness into a gate.
10. **Comments and escalation are off by default** (`desk.workflow`), against the audit's lighter treatment, to keep the default hub
    unchanged for a team that does not want them. Hand-off and the urgent lane are not behind it.
11. **Careful view hides text (not renders it blurred).** A CSS blur still reads aloud. It covers the excerpt, reporter note, AI
    summary and lines, and appeal statements. It is never on by default and never server-side.
12. **Insights needs one small table (`kit_chat_days`)**, unlike the audit's "no new table", because the report rate per 1,000
    lines cannot be had from rows the kit keeps; counting runs only when insights is on. No AI or appeals duplicates on the page:
    existing screens hold them. No scheduler: the digest is a function the adopter calls.
13. **Room modes always expire** (default 30 minutes, at most 24 hours); there is no "until I turn it off". Locked means read-only
    except members the game marks `staff`.
14. **Emergency mode's pieces are the room's pace, new-account read-only, and (from the filter theme) links off.** Without the
    filter theme's built-in it is two of the three.
15. **Retraction is evented**: the staff route calls the core, the core raises `line.retracted`, the broadcaster (or a game's own
    socket) reacts. Staff routes never hold the broadcaster. It works on lines in the 15-minute evidence buffer only.
16. **Probation is a pace floor, never a refusal of speech**, and reads the hook's answer for all the person's accounts (documented as the oldest); unknown ages are
    allowed unless the owner says otherwise.
17. **Surge is shown on the case only**, never in the queue, an event or a decision input.
18. **Linked accounts counts only and has no unlink.** The ban-evasion door behaviour already exists and is pinned by a test.
19. **The evidence ref is server-supplied only** (no client body field), in a closed alphabet with no dot or slash.
20. **Event names:** `case.escalated` (not `report.escalated`) to keep clear of the privacy theme.
21. **Chat wire goes to version 2** with a new frame for the mode and a separate one for retraction (not an overload of `hide`,
    which is per-viewer mute).
22. **Insights is reached from Overview and the command bar**, not a new rail tab, so the rail stays as it is.
23. **A new `CaseMenu` (`...`) on the case** is created in this theme and holds, when applicable: Mark urgent, Ask for a look,
    Escalate to the owner, Lock this room, Remove this line. It renders nothing when it has no item for the person.
