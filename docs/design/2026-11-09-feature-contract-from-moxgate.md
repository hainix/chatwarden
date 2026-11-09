---
status: approved (feature contract for Chatwarden K2/K3)
updated: 2026-11-09
phases:
  - name: "A: AI read on reports (rank the queue, one-line assessment)"
    status: open
  - name: "B: action set rethink (Warning, ladder suggestion, rule picked per action)"
    status: open
  - name: "C: player-facing notice (what you did, what is restricted, optional excerpt)"
    status: open
---

# Moderation: AI read on reports, a rethought action set, and telling the player why

Date: 2026-11-09. Status: owner answered 2026-11-09 (end of file); awaiting approval of the full document. Builds on
`2026-11-07-chat-moderation-design.md` (live as release 484) and the 2026-11-08 reporter-action work.

## Why

Moderation is live and reports are arriving. Three gaps showed up:

1. **Moderators read every report cold.** The queue is newest-first. A slur at a player and a salty "gg ez"
   report look the same until someone opens them. As volume grows, the urgent ones wait behind the noise.
2. **The action set jumps straight to restrictions.** There is no plain warning. A first-time, mild offence
   gets either nothing or a 24 h restriction. Every serious moderation ladder starts with a warning that is
   on the record.
3. **The restricted player is never told why.** Today they learn only when they hit a wall: "A moderator
   restricted your chat" in the chat box, or "You can't join open tables until…" at a door. The
   moderator's reason is never shown (by design: it is written for other moderators). So the player can't
   connect the restriction to what they did, and can't change. A warning they never see is worthless.

Off-the-shelf survey (2026-11-08, `chat-moderation.md` memory): no plugin fits our relay. Perspective API
shuts down 2026-12-31. OpenAI's free moderation endpoint has fixed categories and is likely to flag ordinary
Magic talk ("kill", "destroy", "exile your board") as violence. ROOST Coop (open-source review tool) needs
about 10 services (Kafka, Scylla, ClickHouse, ...). So we keep the built stack and add one model call where
judgment is needed: reading a reported excerpt against a policy we write.

## Goals

1. Every new report gets an **AI read**: a severity, the rule it most likely breaks, a one-line summary
   and the line ids it rests on. Within a minute of the report, without a moderator doing anything.
2. The hub queue **sorts by severity, then age**, so the worst open reports are at the top.
3. Moderators get a **Warning** action, and every action names **the rule broken** from a fixed list.
4. The hub **suggests** the next step from the player's record and the report's severity. It is a
   suggestion only; the moderator chooses.
5. Every moderator action, and every automatic slur timeout, gives the player a **notice**. It says what
   they did (the rule), what is now restricted and until when, and, if the moderator chose to include it,
   **an excerpt of their own lines**. The player sees it wherever they next show up, including when banned.

## Non-goals

- AI on live chat. Still excluded, as in the 2026-11-07 spec. The model reads stored reports only.
- AI deciding anything. It never sanctions, dismisses, closes, warns or reorders anything except the
  queue's sort key. The 2026-11-07 fairness rule stands: nothing another player reports counts against you
  without a moderator looking. The AI read is one more input to that moderator.
- Appeals workflow (the notice carries a "think this is a mistake?" Discord link only).
- Kicking a connected player mid-game (owner ruling 2026-11-08 stands).
- Replacing the slur list or the `obscenity` profanity filter.

## Anti-goals (a failure even if it works)

- An AI read that marks ordinary Magic talk as violent or threatening ("I'm going to kill you with this
  combo", "destroy target creature", "your board is dead"). That would bury real reports and teach
  moderators to ignore the read.
- A notice that reveals **who reported** them, any other player's words or handle, or the moderator's
  private reason.
- Chat text, or an AI summary of it, posted to Discord. The 2026-11-07 rule holds: Discord gets no chat.
- A notice that interrupts a game in progress.
- A player-facing message that reads as a threat or a lecture. It is plain and factual, like the rest of
  our copy.
- Keys, accounts, IP hashes or handles sent to the model.

## Constraints and facts the build relies on

- Reports: `mod_reports` (migration v29 + v33), `excerpt_json` holds the relay-witnessed lines
  (`BufferedLine`: `lineId`, `seat`, `handle`, `raw`, delivered/blocked). Stored via `server/moderation/reports.ts`.
  Categories: `harassment | hate | cheating | spam | disruption | other`.
- Sanctions: `mod_sanctions`, one row per identifier, joined by `group_id`. Kinds `chat | open_table | ban`.
  `POST /mod/sanctions` in `modAdminRoutes.ts` takes `subject, kind, duration, reason, includeIp, force`. Auto chat
  timeouts come from `strikes.ts` (3 slur strikes in 1 h -> 30 min, repeat within 7 d -> 24 h).
- What the player sees today: `chat_rejected { reason: 'restricted', until, byModerator }` -> ChatPanel copy
  `chatModeration.restricted{Until,Forever,ByMod}`. `BANNED` WS error/disconnect plus HTTP 403. `MOD_RESTRICTED` 403 at
  open-table doors (`src/i18n/serverMessages.ts`).
- Identity: `identityFromUpgrade(hasher, clientToken, accountId, ip)` works for both WS upgrades and HTTP doors
  (`DoorWho`). So a notice can be found by account or browser key at any door.
- Existing model plumbing: `server/bugPreflight.ts` `makeAnthropicCaller(apiKey, model, { schema, effort, maxTokens })`
  (structured output) and `makeDailyBudget`. The bug triager (`server/bugTriageRunner.ts`) is the pattern to copy:
  fire-and-forget after the row is stored, a daily call budget, one usage log line per run, fail-soft.
- Kill switches already exist: `CHAT_MODERATION=off`, `MOD_SANCTIONS=off`. Add one for the AI read.
- Copy ships in 6 locales. Mind the i18n essential-key budget (`src/i18n/tiers.ts`; commit fd75a8d66e).
- Push to origin/main is the production deploy. Land on local main; the owner pushes.

## Part A: AI read on reports

### When it runs

Right after a report row is stored, the relay queues the read for that report. The report flow does not wait
for it, and the reporter's `report_ack` is unchanged. One retry after about a minute on a transient failure.
After that the report shows "AI read unavailable" with a **Run AI read** button in the hub. A moderator
pressing it is not limited by the daily budget.

Skipped, with no model call, when:
- the reported person sent no lines in the excerpt. The hub already says "X sent no messages", and the read
  is recorded as `no_lines` (severity `none`). The report still needs a moderator; cheating and disruption
  reports rarely have chat.
- the daily budget is spent (`unavailable: budget`), or `MOD_AI_READ=off`.

### What the model gets

- **The policy**: a fixed system prompt in the repo (`server/moderation/aiReadPolicy.ts`). It holds the
  community rules in plain words (the same rules list Part B uses) and an explicit "this is a Magic game"
  section: killing, destroying, exiling, sacrificing, burning, "you're dead" and so on, said about cards,
  life totals or the game, are normal play talk and never a violation. Trash talk about play ("bad keep",
  "gg ez") is low at most. The cached prefix (system prompt) is identical for every call.
- **The report**: category, the reporter's note (marked untrusted), and the excerpt lines in order. Each line
  is labeled by role only: `REPORTED`, `REPORTER`, `PLAYER_C`, `PLAYER_D`, ... Handles and seat names are
  replaced. A blocked line is marked `[blocked by filter]` and its text is kept, so the model sees what was typed.
- Nothing else: no keys, accounts, IP hashes, handles, room codes or player history. History is the
  moderator's job, and the ladder (Part B) handles it deterministically.

### What the model returns (structured output schema)

```
severity:        'high' | 'medium' | 'low' | 'none'
rule:            one id from the rules list (Part B), or 'none'
summary:         <= 160 chars, plain English, describes conduct without quoting slurs
                 ("Repeated racial slurs aimed at REPORTER after losing a game.")
evidenceLineIds: string[]  (ids from the excerpt; empty when severity is none)
reporterConduct: 'fine' | 'also_abusive' | 'looks_bad_faith'
confidence:      'high' | 'low'
```

The relay validates the reply. An unknown rule id, or line ids not in the excerpt, are dropped, and an
invalid reply counts as a failure. Summaries are shown in the hub only, always in English (moderators work in
English). Chat and the reporter's note are untrusted input: the policy tells the model to ignore instructions
inside them. The schema means a successful injection can at worst produce a wrong label, which a moderator
reviews.

### Storage

A new table `mod_report_reads` (migration v34): `report_id PK -> mod_reports`, `at`, `model`, `status`
(`ok | no_lines | failed | budget | off`), `severity`, `rule`, `summary`, `evidence_json`, `reporter_conduct`,
`confidence`, `input_tokens`, `output_tokens`. Rows are deleted with their report (90-day purge). A re-run
overwrites the row. Builder's call: a table rather than columns on `mod_reports`, so the read can be re-run and
purged on its own without touching the report row.

### Model and cost

`claude-haiku-5-5`, low effort, small `maxTokens`. Key: `ANTHROPIC_API_KEY_MOD_READ || ANTHROPIC_API_KEY`,
the same fallback pattern as bug triage. Daily budget env `MOD_AI_READ_DAILY` (default 200 calls). Usage is
logged per call in the bug-triage format. The builder takes current prices from the claude-api skill, not
memory, and states cost per report and per month at current volume in the plan.

### In the hub

- **Queue and Needs review** are two screens (`ReportQueue.tsx`, and `Overview.tsx` "Needs review"). Both get
  the sort and the chip. The queue is grouped by reported player (`modAdminRoutes.ts` `/queue`: `reportIds`,
  `latestAt`, `categories`), so a group's severity is the **highest** severity among its **open** reports, and
  its rule is that report's rule. Order: severity `high > medium > low > none/unread`, then by the **oldest open
  report** in the group, oldest first, so nothing urgent ages out of view. A "Newest first" toggle restores
  today's order (`latestAt` desc). "Unread" (no AI read yet) sorts with `low`, never above a real severity.
  Builder's call: the relay's `/queue` joins `mod_report_reads` and returns `severity`, `rule` and
  `oldestOpenAt` per group, and the hub sorts. Ranking stays in one tested pure function.
- **Report page**: an "AI read" card above the excerpt. It shows severity, rule, summary and confidence, with
  a fixed caption: "A suggestion from an AI model. It can be wrong. You decide." Lines in `evidenceLineIds`
  are highlighted in the excerpt. `reporterConduct` other than `fine` shows as a line in the reporter
  section ("The AI read thinks the reporter was also abusive"). It is never a pre-filled bad-faith verdict.
- **Guide**: one paragraph saying what the AI read is, what it sees, and that it never acts.
- The decision panel's verdict and action selects are **never** pre-filled from the AI read. The ladder
  suggestion (Part B) may use the read's severity, and it is shown as a suggestion line, not a selection.

### Discord

Owner 2026-11-09: the Discord report post shows the AI's rating. The forum post gains "AI read: high · CR 2"
(severity and rule number), and is edited in place when the read lands after the post. Never the summary:
it is derived from chat text, and Discord gets no chat.

### Optional

The AI read is an optional feature (owner 2026-11-09). It is off unless `MOD_AI_READ=on` and a key is set.
Every surface degrades cleanly without it: the queue sorts newest-first, there is no AI card or Discord tag,
and the ladder uses its no-read fallback. This also matters for the shared-library work (a separate
brainstorm, `2026-11-09-open-moderation-brainstorm.md`): adopters opt in and bring their own model provider.

### Evaluation (before turning it on)

A fixture set `server/moderation/aiReadFixtures.ts` of about 40 synthetic excerpts, hand-labeled with the
expected severity. It must include at least 10 pure Magic-violence/play-talk cases (expected `none`), slurs in
en/es/pt, targeted harassment without slurs, spam, a reporter-was-the-abuser case (the
V4Wl9WoslmEhtCNqRf8lcw shape), and injection attempts in chat and in the note. Unit tests run against a mocked
caller (prompt assembly, role labeling, no identifiers in the payload, schema validation, budget, skip rules,
retry). A separate script `scripts/mod-ai-read-eval.ts`, run by hand with a key, never in gates, sends the
fixtures to the real model and prints a confusion table. Ship gate: zero play-talk fixtures above `low`, and
every slur fixture at `high`.

## Part B: the action set

### The actions (after this change)

| Action | What it does | New? |
|---|---|---|
| **Warning** | Nothing is restricted. The player gets a notice they must acknowledge. It is on their record. | new |
| Chat restriction | As today | notice added |
| Open-table ban | As today | notice added |
| Full ban | As today | notice added |
| Dismiss / Dismiss as bad faith / Add note / Revoke | As today | Revoke also withdraws the notice |

No name-reset action (owner 2026-11-09): names are enforced at the edit point (`nameCheck`), which is where
that belongs. An offensive name that gets through is a gap in the term list, not a moderator action.

**Storage of Warning.** A Warning is a `mod_sanctions` row with a new kind `warning`. It has no door effect:
`ends_at = starts_at`, so `SanctionIndex.load`'s `ends_at > now` filter never loads it, and no IP row is ever
written for it. That reuses group ids, linked-identity targeting, history, Recent actions and the Discord outcome
post. The current code needs:
- a new `applyWarning(db, { targets, rule, reason, moderator }, now)` beside `applySanction`. `applySanction`
  rejects `durationMs <= 0` on purpose and keeps doing so.
- the `POST /mod/sanctions` route accepting `kind: 'warning'` with `duration` absent, and refusing `includeIp`
  for it. `KINDS` / `DURATIONS` stay whitelists, extended accordingly.
- a migration widening the `kind` CHECK (SQLite table rebuild, as earlier mod migrations did).

Tests prove a warning never refuses at any door.

**The sanction request.** `POST /mod/sanctions` gains optional fields: `rule` (a CR number; defaults to "not covered" with an empty gap note
when absent, so existing callers and tests keep working), `reportId` and `lineIds` (the excerpt to show the
player). `lineIds` is only accepted with `reportId`, and the relay checks each id belongs to that target
(Part C). The DecisionPanel already sends one request per target, so each target carries its own `lineIds`.
`SanctionForm` and the player-history page get the Rule select too, but no excerpt (there is no report).

### Community Rules (CRs), and every action cites one

Owner 2026-11-09: moderators pick from numbered rules, never free text to the player. So the rules become a
**numbered public document**, in the spirit of Magic's Comprehensive Rules.

- **Source of truth**: one module `src/moderation/communityRules.ts` (shared by relay, client and hub). Each rule
  has a stable number, a short title and one or two plain sentences. A number is never reused or renumbered;
  a retired rule stays listed as retired. The AI read's policy prompt is built from the same list, so the
  model and the moderators judge against identical words.
- **Public page** `/rules/` (localized, in the site header/footer and linked from the report dialog, the
  notice and the Privacy Policy). Builder's call on layout; it is static content.
- **Starting rules** (titles; the builder writes the sentences per `design-and-copy-rules.md`):
  - CR 1 No slurs or hate aimed at who someone is
  - CR 2 No insulting, threatening or targeting another player
  - CR 3 No sexual messages
  - CR 4 No spam, flooding or advertising
  - CR 5 No cheating or exploiting
  - CR 6 No throwing, stalling or ruining games on purpose
  - CR 7 No offensive names
  - CR 8 No false reports (already in the report dialog's warning; this makes it citable)
- **Decision panel**: a required **Rule broken** select listing the CRs. It is pre-selected from the report
  category (the AI read's rule wins when present). The moderator's free-text reason stays required and stays
  private. The rule is stored on the sanction row (new nullable column `rule`, the CR number; auto slur
  timeouts write CR 1).
- **No rule fits**: the last option is **"Not covered by a rule yet"**. Picking it requires a **rule-gap note**
  addressed to the owner ("what happened, and what rule is missing"). The note is stored on the sanction row
  (`rule_gap_note`) and is never shown to the player. The hub Overview gets a **Rule gaps** list (owner
  role: the note, the moderator, the date, a link to the report) with a "Turned into CR n" / "Not a rule"
  close-out. Turning a gap into a CR is a code change in a later pass, never live editing. The player's
  notice for this case says the moderator judged the behaviour harmful to other players and that it is not
  yet a numbered rule (copy left to the builder).

### Suggested next step (the ladder)

A pure function `suggestAction(record, severity, rule)` in the hub, with unit tests. It is shown as one line
under the action select ("Suggested: Restrict chat 24 hours. 1 warning in the last 30 days."). It never
selects anything.

Each prior action (this person and linked identities, `starts_at` within the last 90 days, not revoked) maps to a
step. The record's step is the **highest** of them:

| Step | Prior actions that reach it |
|---|---|
| 0 | nothing |
| 1 | one warning |
| 2 | two or more warnings; any chat or open-table restriction shorter than 7 days (auto slur timeouts included) |
| 3 | a chat or open-table restriction of 7 days or more; a full ban shorter than 7 days |
| 4 | a full ban of 7 days up to 30 days |
| 5 | a full ban of 30 days or more; anything permanent |

| Record step | Low / medium severity suggests | High severity, or CR 1, suggests |
|---|---|---|
| 0 | Warning | Restrict chat 7 days |
| 1 | Restrict chat 24 hours | Restrict chat 7 days |
| 2 | Restrict chat 7 days | Full ban 7 days |
| 3 | Full ban 7 days | Full ban 30 days |
| 4 | Full ban 30 days | Full ban permanent |
| 5 | Full ban permanent | Full ban permanent |

Revoked actions don't count. Rows pruned 90 days after they end (`wire.ts`) are already outside the window.
The kind of the suggested action follows the rule: CR 5 (cheating) and CR 6 (ruining games) suggest an
open-table ban in place of a chat restriction at the same length.
Severity comes from the AI read
if there is one; without one, use `medium` (`high` for the `hate` category). The table lives in one constant
with the Guide rendering it, so moderators can see the ladder they are being nudged along.

### Presets

`ACTION_PRESETS` becomes: Warning · Restrict chat 24 h · Restrict chat 7 d · Ban from open tables 24 h · Ban
from open tables 7 d · Full ban 7 d · Full ban 30 d. "Something else" keeps the free kind × duration form
(warning has no duration). The hub's `SANCTION_KINDS.playerSees` text is rewritten to describe the notice.

## Part C: the player notice

### What it says

A small dialog in the app's own style, localized in all 6 locales:

> **A moderator warned you** / **Your chat is restricted until Tue 14:30** / **You're banned until 16 Nov** / ...
>
> **Why:** Community Rule 2: No insulting, threatening or targeting another player. *(links to /rules/#cr-2)*
>
> **What you wrote** *(only when the moderator included it)*
> "…your own line…"
> "…your own line…"
> *In a game on 8 Nov.*
>
> **What this means:** [one line per kind, e.g. "You can still play and read chat. You can't send messages
> until then." / "Nothing is restricted. Another report like this will lead to a restriction."]
>
> Think this is a mistake? Tell us on Discord. *(links to `DISCORD_URL`; a link only, no appeal flow)*
>
> [I understand]

- **Never in it**: the reporter, other players' lines or handles, the room code, the moderator's name or
  reason, the AI read.
- **Excerpt**: in the decision panel, for each person being acted on, a checkbox list of **that person's own
  lines** from the excerpt. It is pre-ticked with the AI read's evidence lines that belong to them, or
  with the reported line (`line_id`) when there is no read. Untick all to send no excerpt. At most 5 lines.
  Blocked lines are included as typed, but with the matched slur term starred (`stripInvisible` + matcher
  span), so the notice does not reprint a slur. The date is the day only, to keep it vague in multi-player
  games. In a 1v1 the opponent is obvious anyway, and that is acceptable.
- **Whose lines are whose.** Today's stored excerpt has seat and handle per line but no identity
  (`reports.ts` strips it), and `people_json` keeps one seat per person, while seats can change hands. So new
  reports store, per excerpt line, `p`: the index of its writer in that report's `people_json`, taken from the
  buffered line's own `identity` at snapshot time. Only lines whose `p` matches the target can be ticked, and
  the relay re-checks this on the sanction request. Reports stored before this change **fail closed**: no
  excerpt is offered, and the notice goes out without one. Those reports purge within 90 days anyway.
- **Auto slur timeouts** get a notice too, with CR 1 and the blocked line that triggered the third
  strike (starred), so the 30-minute timeout explains itself. `strike()` (`chatPipeline.ts`) is not given the
  line text today, so it has to be passed in from the call site. The in-memory fallback path and keyless
  sessions write no `mod_sanctions` row, so they get **no notice**. The existing chat-box refusal still
  tells them they are restricted.

### Storage

New table `mod_notices` (migration v34): `id`, `group_id -> mod_sanctions.group_id`, `kind`, `rule`, `until`,
`excerpt_json` (just the ticked lines: text plus day; no ids, seats or handles), `created_at`, `acked_at`,
`withdrawn_at`. Targets are found through the sanction group's account/key rows (IP rows never deliver a
notice: a shared address must not show a stranger's notice). Purged 90 days after the later of creation and the
sanction's end.

### Delivery

- **HTTP** `GET /api/notices` (client token header + optional session, the same `DoorWho` as other doors)
  returns unacknowledged, non-withdrawn notices for that identity, oldest first.
  `POST /api/notices/:id/ack` marks one acknowledged; only an identity the notice targets may ack it. The app
  calls GET on load and after any `BANNED` / `MOD_RESTRICTED` refusal. So a banned player still sees why on
  the error screen, and the ban screen gets a "See why" link.
- **WS**: on attach, the relay sends a `mod_notice_pending` frame (no content, just a count) when the
  identity has one, and the client fetches over HTTP. This keeps notice content in one code path.
- **Timing**: never interrupts a game in progress. If a notice arrives mid-game, the client holds it until the
  game ends or the player leaves the room. A pending **warning** is shown before the player's next create or
  join, and must be acknowledged first (owner 2026-11-09). This is a **client-side** step in the join flow, not a server refusal: a warning
  restricts nothing, so a modified client skipping the dialog loses nothing we care about. No door code
  changes for warnings. A restriction or ban notice is shown once; after
  ack it stays reachable from the chat box's restricted line ("See why") and the ban/open-table refusal
  screens while the sanction lasts.
- **Revoke** sets `withdrawn_at`. An unseen withdrawn notice is never shown; an already-seen one simply stops
  being linked.
- The relay's `chat_rejected { reason: 'restricted' }` gains an optional `noticeId` so the chat line can link
  to it.

## Rollout

Phase A first, behind `MOD_AI_READ=off` until the eval passes on the real model. Then flipped on, and the
hub sort shipped with it. Phases B and C ship together: Warning is pointless without the notice, and the
`/rules/` page ships with them. Before Phase A goes on, the Privacy Policy (`src/components/Legal/PrivacyPolicy.tsx`,
the "When a player reports another player" paragraph) gains a plain line: if something you say is reported,
moderators review it, with help from an AI service that reads the reported excerpt (owner 2026-11-09).

## Testing

Test-first throughout (owner directive), targeted runs only: `npm run gates:quick` + vitest/jest by path, never
the full suite. Lock at least:
- AI read: payload carries no keys/accounts/IPs/handles/room codes (fuzz the excerpt with identifier-shaped
  strings in handles), role labeling stable across seats, schema rejection paths, skip rules, budget, retry,
  re-run overwrite, purge with report, kill switch.
- Queue sort: tiers, oldest-first within a tier, unread placement, toggle.
- Ladder: every cell of the table, revoked ignored, auto timeouts counted, linked identities counted, no-read
  fallback.
- Warning: never refuses at any door (chat, open table, ban checks), appears in history/recent/feed.
- Notice: only the target's own lines can be ticked (server rejects foreign line ids), starring of blocked
  lines, 5-line cap, IP-only identity gets nothing, ack by a non-target refused, withdrawn on revoke, held
  during a game, warning gates the next join, ban screen fetch path, the 6 locales present.
- Discord: no summary/rule/chat in any post (extend the existing no-chat-in-Discord tests).

## Left to the builder

Exact copy wording (plain, per `design-and-copy-rules.md`), hub layout of the AI card and chips, the notice
dialog's styling, migration mechanics, retry timing, prompt wording beyond the requirements above, file
layout under `server/moderation/`.

## Owner answers (2026-11-09)

1. AI read: yes, and it is an **optional** feature. Privacy Policy says reported chat is reviewed, with AI help.
2. Discord report post shows the AI rating (severity + CR number, never the summary).
3. A warning must be acknowledged (before the next game, client-side).
4. No Reset name: names are enforced at the edit point.
5. No free text to the player: moderators pick a numbered Community Rule. When none fits, they leave a
   rule-gap note for the owner, and a later pass adds the rule.
6. "Think this is a mistake?" Discord link in the notice: yes.

Calls made by the spec author after the answers (check while reading): CRs live in one shared module plus a
public `/rules/` page; the starting list is 8 rules including CR 8 false reports; numbers are never reused;
rule-gap notes get an owner-only hub list with a close-out; the Discord tag carries the CR number as well as
the severity.
