---
status: approved
updated: 2026-11-10
---

# The moderator hub as a team workbench (addendum to the 2026-11-09 design)

The owner reviewed the first hub screens on 2026-11-10 and asked for "a full pass ... like a paid corporate product with polish,
things async, modern polished feel", designed for "teams of moderators ... (queues claiming etc)". The direction mockup is the
artifact "Chatwarden Workbench Direction" (v2). This addendum records what was decided. It changes K4 and adds to K3 (AI levels).

## Who it is for

Teams of human moderators first: a small studio's volunteers and staff, often several on at once. AI is a labelled teammate, never
the one who decides below level 3. Every screen has its own URL and stable accessible names, so an AI agent driving a browser can
use the hub too, but the hub is not designed around that.

## The flow

- **A workbench, not pages.** Three panes: the queue (left), the open case (middle) and the person's record (right). Opening a
  case never leaves the queue. At phone width the panes stack.
- **One case per person.** Reports about the same person merge into one case, as the queue already groups them.
- **Claims are soft locks** (owner, 2026-11-10: "yes soft").
  - Opening a case claims it if nobody holds it. "Take next" claims the oldest unclaimed case that matches your filters.
  - A claim lasts while you work (a heartbeat). It is released after 10 minutes without one, when you release it, or when you decide.
  - Others can still read a claimed case, but they cannot decide it. A senior or owner can take it over, and the audit trail
    records that.
  - "Viewing" (someone has the case open) is shown separately from "handling" (holds the claim). Viewing never blocks anyone.
- **Filters, not routed queues** (owner: "filter"). The queue filters by category, by claim (all, unclaimed, mine) and by wait.
  Routing rules that send cases to separate queues are not part of this phase.
- **One decision bar** docked under the evidence. It comes pre-filled: the ladder suggestion, the rule, and the person's own lines to
  show them. Verdict keys 1/2/3. Saved reasons, managed by seniors and owners. "Decide and take next" with Ctrl+Enter.
- **Undo window.** A decision leaves the screen at once and is held for 5 seconds with Undo before it is sent. It is sent at once if
  the hub is closing.
- **Keyboard first.** J/K move through the queue, N takes the next case, Ctrl+K opens a command bar (jump to a person, report, term
  or screen), and ? lists every shortcut.
- **Async everywhere.** The queue refreshes in the background, polling a cheap change token every few seconds while the tab is
  visible and backing off while it is hidden. New cases wait behind an "N new" pill, so the list never moves under the cursor.
  Loading uses skeletons, not spinners. A banner says when the connection is lost and when it is back.
- **Team view.** The overview shows the team: who is on and what each person holds, the oldest wait, and a shared recent-actions
  feed. It shows team totals and current load per moderator, and no per-person leaderboard (it rewards speed over care).
- **Easier on moderators.** Blocked words are masked until a moderator chooses to see them, per line or for the case. An optional
  "take a break" nudge after a long run of decisions is off by default.

## The look

- Calm, dense and neutral, in the style of professional triage tools: chrome and navigation recede, and the case in focus carries the
  weight.
- **Colour only where it means something** (owner: "don't use too much different color types unless they mean something").
  - Blue: you, and your next action (primary button, selection, focus, your claims).
  - Red: overdue, the reported line, a ban.
  - Yellow: a warning.
  - Everything else is neutral: no per-category colours, no coloured avatars, no colour per speaker.
- The one signature detail is the referee card: a yellow card for a warning, half yellow and half red for a restriction, and red for
  a ban. It is used wherever a sanction is shown.
- Type: Instrument Sans through an optional self-hosted font file (`@chatwarden/hub-react/font.css`, about 25 KB). The default is
  the system UI font, so the package loads nothing from a third party.
- The theme is built from a few inputs (base, accent, contrast) exposed as `--cw-*` variables.

## What the kit adds for this (staff API)

- Claims per person, with expiry, heartbeat, release and take-over (new permission `claims.override`, senior). `decide` refuses a
  case held by someone else (409 `claimed`) unless the caller takes it over.
- Take next: claim and return the oldest unclaimed open case that matches the given filters.
- A change token for the queue and claims, so the hub reloads only when something changed.
- Viewing presence: short-lived, in memory, per process. It is a hint, never a lock.
- Saved reasons: listed by moderators and managed by seniors and owners.
- All of it is plain request/response HTTP, so it runs on any server. Streaming is not required.

## Human decisions teach the AI (adds to K3)

The owner (2026-11-10) asked to "allow human data to label and educate the AI moderators automatically".

- Every human decision becomes a labelled example automatically. It records the case, the AI read if one existed, and what the
  moderator decided: verdict, rule and step. Reversals and take-overs are labels too.
- These labelled examples are the casebook. The AI read uses the closest agreeing examples as references at read time (in-context
  examples). It is never a model fine-tune.
- The same examples are the eval set. The agreement rate per level, and the gates for levels 3 and 4, are measured on them.
- **Guards:**
  - A decision on a bad-faith report, a decision later reversed, and one a senior marks "don't teach" are excluded.
  - Identifiers are removed before an example is stored (person refs become "the reported player" or "another player").
  - The casebook lives in the adopter's own store and goes only to the adopter's own model provider, as part of a read.
- This revises the 11-09 line "fixtures added by humans, never automatic training". Examples are now added automatically from
  human decisions, but they are only examples and evaluation, never weight training, and a human decision is always the label.
