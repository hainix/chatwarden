---
status: approved
updated: 2026-11-10
---

# Steps and ladder editable in the hub, and the moderation-tools roadmap

## Why

On 2026-11-10 a Moxgate moderator (Lae, in Moxgate Mods) asked for "more sanction options. Less restrictive ones, like: 1 hours, 6
hours, 12 hours..chat restrict/ban from open table", and for a light "tap" for players on the edge: "I believe it's healthier to
simply make one's presence known, without having to act like an executioner." The owner replied there: "working on making this
configurable". He then asked whether the kit supports "fully configurable ladders and restrictions" and the other things moderators
might want.

Where the kit stood:

- **Configurable, but only in code.** The ladder (6 steps, a lighter and a harsher column, any type and any duration up to 365 days or
  permanent), the first offence per conduct level, the repeat rule, the area and severe rules, and the profanity handling are all
  set in `createChatwarden({ profile, overrides })`.
- **Not editable by moderators.** Neither the hub nor Moxgate's current tool lets anyone change them. The hub's manual picker only
  offers durations the ladder already uses.

## The owner's decisions (2026-11-10)

- **Where it is edited:** a settings screen in the hub, for the owner role.
- **Light tap:** use a warning. There is no new sanction type.
- **When:** in this release (0.1.2), before the site demo and release prep.
- **Roadmap:** offensive names, an appeals inbox, slow mode and flood control, and generic **signals**. In the owner's words:
  "add support to wire end, metrics and logging, so for example if someone is being muted by other players, that should be a good
  signal that that player is probably causing issues or if they get and kick some servers or kick from the chat, that's probably
  good indication, but again make it generic because everyone doesn't have the same table format or work like ours, so build it
  generically so that you can add in features that will contribute to like deciding what ladder to put and what AI moderation to
  take".

## Part 1: Steps and ladder (this release)

### The kit

- **Effective profile.**
  - The profile given in code (a preset plus `overrides`) stays the base.
  - Edits from the hub are stored separately in the adopter's own store, as a validated override layer with a version number.
  - The effective profile is: base, then code overrides, then stored overrides, validated by the existing `validateProfile`.
  - "Reset" removes the stored layer, for one section or all of it.
- **What can be edited:**
  - the duration choices
  - the ladder grid (each cell's type and duration)
  - the first offence per conduct level
  - the repeat rule
  - the area rules
  - the severe rules
  - the outcome text of the written guidelines

  Profanity handling stays code-only in this release, because changing it means rebuilding the filter.
- **New profile fields:**
  - `durations: number[]`: the lengths offered to moderators. The default is 1 hour, 6 hours, 12 hours, 24 hours, 3 days, 7 days
    and 30 days. Permanent is always offered, subject to permission.
  - `customDuration: boolean`: whether a moderator may type their own length. The default is true.

  Ladder cell labels are generated from the cell's type and duration when the cell is edited.
- **Live effect.**
  - Every suggestion, decision check, document (guide, code of conduct, AI brief) and the `cw.profile` read use the effective
    profile.
  - Another process sees a change within 10 seconds, by checking the stored version.
  - Sanctions already given are untouched.
- **Storage.**
  - Two new optional `Store` methods: `loadPolicyLayer()` and `savePolicyLayer(layer, expectedVersion)`.
  - They are implemented in the memory and SQLite stores.
  - A store without them still works. The settings screen then says the store cannot save settings, and the profile stays
    code-only. This keeps adoption easy for custom stores.
- **Routes:**
  - `GET /policy/profile` returns `{ effective, base, layer, version }`.
  - `PUT /policy/profile` takes `{ layer, version, reason }`. A version mismatch answers 409. An invalid layer answers 400 with the
    field path.
  - `POST /policy/profile/preview` takes `{ layer }` and returns the suggestions for a fixed set of sample records.
  - `DELETE /policy/profile?section=` resets one section, or everything.
  - New permission `policy.write`, for the owner only.
  - Each change is audited as `policy.update`, with the sections changed and the reason.

### The hub

- **Settings, then "Steps and ladder"** (under More in Simple). The owner edits; seniors and moderators read. The sections are:
  - **Durations:** chips to add and remove, plus the custom-length switch.
  - **The ladder grid:** 6 rows and 2 columns, each cell a type and a duration from the list.
  - **First offence** by conduct level.
  - **Repeated:** notes, days, and whether they must come from different games.
  - **Rules that ban from public rooms instead of restricting chat**, and **rules that always use the harsher column**, both as rule
    pickers.
  - **The written guidelines' outcome text.**
- **Preview.** A live panel shows what would be suggested for sample records (clean; one warning; a 24-hour restriction; a 7-day
  ban), for each conduct level, before saving.
- **Saving.** Saving takes a reason. A version conflict tells the owner someone else changed the settings and offers to reload.
  There is a reset per section and a reset for everything.
- **Picking a length.** The decision bar and the sanction form offer the profile's durations, plus "Custom length" when allowed,
  plus permanent when the role may give it.
- **Light tap.** The Simple card adds "Send a warning" beside the suggestion when the suggestion is harsher than a warning. This is
  Lae's light tap, in one click, with the same Undo.

## Part 1b: Reporting is editable too (this release)

The owner asked for this on 2026-11-10: "The reasons a user gives for reporting should be configurable by the person integrating
it, so it should be part of the settings. It should have good defaults, and it should also have an option for generic reporting
where someone just reports like a message, and then we on our end either tell them thanks for the report, we'll look into it, so
that the AI can parse what's going on and make the judgment, as opposed to oftentimes the reporter will put in the wrong reason or
just put in any reason."

Research behind it (2026-11-10):

- **Roblox**
  - Reporting starts from one Report entry, aimed at the exact chat message.
  - Its creator dashboard says the categories players pick "may sometimes be inaccurate", and moderators confirm the category
    before acting.
  - In July 2026 it changed the flow to adapt its questions to the type of report.
- **Discord:** "Report Message" leads to a short tree (abuse or harassment, spam, other). On mobile the labels describe feelings.
- **Riot**
  - Valorant groups reasons into Communication, Gameplay integrity and Participation.
  - League's system reads the chat log and the report history rather than trusting the chosen reason.
- **Research** ("Too Difficult to Report?", Policy & Internet): longer category trees bring more abandonment and more
  misclassification.

The owner's decisions:

- **Default flow: one tap, reason optional.**
  - "Report this message" sends at once and shows the thank-you.
  - A short follow-up then offers an optional reason and note, which attach to the same report.
  - Studios can switch to "pick a reason first" or "reason required".
- **Default reasons: grouped and game-style.**
  - Chat: insults or harassment, hate, sexual content, threats, spam or ads, sharing personal info.
  - Gameplay: cheating, throwing or griefing, leaving or AFK.
  - Plus "Something else".
  - Each reason maps to its usual Community Rules.
  - Studios edit labels, hints, groups, rule mapping, "asks for a note", and on/off.
- **Ships in 0.1.2,** after the ladder settings.

What it means in the kit:

- **The reporter's reason is a hint.**
  - It is stored as `reportedReason` (a reason id or null).
  - The case's category is what the moderator's decision, or later the AI read, settles.
  - The hub shows "Reported as …" or "No reason given".
  - Reporter accuracy (how often the reported reason matched the decided rule) joins the reporter's record.
- **Compatibility.** The six existing category ids stay valid and map onto the new default list, so existing adopters and stored
  reports keep working. A report's reason must be an enabled id from the list, or null.
- **The thank-you.** Its copy ("Thanks for the report. We'll look into it.") and the outcome notice copy are part of the reporting
  settings.
- **A "no reason given" report** shows the moderator the lines and asks which rule applies, with the suggestion computed once the
  rule is picked. When the AI levels arrive (K3), the AI read proposes the rule and the step.

## Part 2: the roadmap (later releases; each gets its own brainstorm before building)

- **Offensive names.** Check player names against the term list at sign-up and rename. Moderators can force a rename, and the player
  is told to choose a new name. Names show masked in the hub, like chat lines.
- **Appeals inbox.** "Think this is a mistake?" becomes a player route that files an appeal against a sanction or decision, with a
  rate limit. Appeals land in the hub as their own queue. An appeal is decided by uphold, reduce or revoke, and the player gets an
  outcome notice. The owner (2026-11-10): "granted appeals should flow back into the decision engine that makes the ai call so it
  reduces further false positives". So a granted appeal:
  - marks the original decision reversed, which keeps it out of the casebook as a positive example
  - adds a corrective "false positive" example for that rule and conduct level
  - counts toward a per-rule false-positive rate

  A rule whose false-positive rate is high needs more confidence before the AI may act on it alone. The rate also counts toward
  the gates for AI levels 3 and 4.
- **Slow mode and flood control.** Per-room settings: a minimum time between lines, a burst limit, and duplicate-line suppression.
  They are set by the adopter's defaults and adjustable in the hub, and the kit's chat path enforces them. Flooding is a signal (see
  below).
- **Signals: generic, game-defined evidence.**
  - Games record what their own systems see, in their own terms:
    `cw.signals.record({ kind, subject, by?, roomId?, at?, weight? })`.
  - The kinds are the adopter's own strings, declared once in the profile with a label, a polarity and a default weight. Examples:
    `muted_by_player`, `kicked_from_room`, `left_mid_game`, `blocked_by_player`, `flood_triggered`.
  - Nothing assumes Moxgate's tables or room model.
  - Signals are counted over windows: N distinct players in D days, deduplicated by `by`, so one grudge cannot count ten times.
  - Signals feed three places, each by explicit profile rules, never silently:
    - the hub, as lines on the person's record and an optional queue-ordering boost
    - the ladder, as a threshold that adds a note or raises the suggestion one step
    - the AI read, as context given to the model with the case
  - Signals carry no chat text and no free text, only ids, kinds and counts. Retention follows the kit's retention settings.
  - Collusion and brigading guards are part of the brainstorm: distinct reporters, new-account weighting and caps.
