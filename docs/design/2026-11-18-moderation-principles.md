# Moderation principles: recommended at setup, edited by the team, used everywhere

Status: proposed by the controller, 2026-11-18, from the owner's direction. Release: 0.2.2 (additive).

## 1. Why

Owner, 2026-11-18: "it's reasonable for chatwarden to start with some recommended/boilerplate moderation principles, maybe in a nux or
based on what type of game or integration we have, and then let admins update those principles and that should work into the AI
moderator tools etc."

The kit already has the pieces. A profile carries `guidelines`, an ordered list of tiers (title, description, examples, the conduct levels
it covers, and an outcome). The three presets carry their own tiers, and Moxgate's agreed principles are word for word the `relaxed`
preset's five tiers. The moderator guide, the agent brief and the player code of conduct are built from them. What's missing:

- The hub lets a team edit only each tier's outcome line. It can't rename a tier, rewrite the description or examples, add a tier, or
  remove one.
- The AI read's prompt never sees the tiers. It gets the Community Rules, the level meanings and one free-text `aiContext`, so a team
  that rewrites its principles changes the guide but not what the AI weighs.
- Nothing helps a new team choose. `chatwarden init` asks "Which standard?" (relaxed, standard or strict) without saying what kind of
  game each one suits, and the hub has no first-run step at all.
- There's no place for the team's working notes, such as "weigh distinct tables over raw counts" or "ask in the forum thread before you
  act". Moxgate keeps those on a page of its own outside the kit.

## 2. Goals, non-goals

### Goals
- **Principles, fully editable in the hub.** Owners and seniors can edit each tier's title, description, examples, the levels it covers
  and its outcome. They can add a tier (up to 12), remove one (at least 1 must remain), and reorder them. Saves are live, versioned and
  audited like every policy section. "Reset to the preset" stays available.
- **Team notes.** A new, ordered list of short staff-only notes: up to 30, each up to 500 characters, with an optional link to a
  Community Rule number. Players never see them.
- **Used everywhere:**
  - The moderator guide shows the principles and team notes.
  - A case shows the tier that matches the report's conduct level, and the notes linked to its Community Rule, behind the Detailed
    disclosure.
  - The agent brief includes both.
  - The AI read prompt gets both, in its STABLE part, reduced to one line each, length-capped, and screened by the existing injection
    check. A tier or note that trips the check is left out of the prompt and flagged in the hub.
  - The player code of conduct keeps deriving from the tiers, as it does today. Team notes never reach players.
- **Recommended at setup:**
  - The hub gets a first-run panel for owners, shown while no policy layer has been saved and the team hasn't dismissed it. It asks
    "What kind of game is this?" and recommends principles to match, with a preview. One click applies them; "Keep the current ones"
    dismisses the panel.
  - `chatwarden init` asks the same question.
  - The choices:
    - **Competitive or PvP games, with trash talk expected:** `relaxed`.
    - **Social or casual games, with mixed ages:** `standard`.
    - **Games for kids or teens:** `strict`.
    - **Creator and streaming communities:** `standard`, plus the team note "Protect the creator and their guests from targeted
      abuse".
  - Every choice can be edited afterwards.

### Non-goals
- Generating principles with an AI. The recommendations are fixed, reviewed text.
- Per-room or per-context principles. Contexts (0.2.0) can already switch presets; that stays as it is.
- Any change to how the ladder, the first-offence outcome or the repeat rule decide sanctions. The principles describe them, and the
  existing warning stays: if you change the outcomes, change the principles to match.

## 3. Rulings
1. The tiers stay `profile.guidelines` (`GuidelineTier[]`). No rename in code, so 0.2.2 stays additive. The hub calls them "Moderation
   principles".
2. Team notes are a new optional profile field, `teamNotes: { text: string; rule?: number }[]`, defaulting to `[]`. They're validated
   (trimmed, with control, bidi and zero-width characters stripped) and refused when over the cap, never cut.
3. A tier's text in the prompt: `- <title> (covers: <levels>): <description> Outcome: <outcome>`, one line each, after the level meanings.
   Notes come as `- Team note: <text>`. The STABLE part's hash includes them, so a change starts a new prompt version, as any policy
   change does. The total added to the prompt is capped at 4,000 characters. Notes past the cap are dropped, last first, and the hub
   says so.
4. The first-run panel is owner-only. Whether it was dismissed is stored as a kit_meta flag. It shows nothing once a policy layer exists.
5. Moxgate keeps `relaxed`. Its judgement guidelines, the forum line, and the privacy and conduct wording move into team notes. The
   "Moxgate notes" page is then deleted.

## 4. Left to the builder
The hub layout of the editor, within the clean-core rule and the existing policy panel components. The exact preview text. Test names.

## 5. Builder-check rulings (2026-11-18, the controller's calls)

1. **The tier invariants stay.** Every tier covers at least one level. Each cover (banter, rude, hostile, severe, repeated,
   after_warning) sits in exactly one tier, and all four conduct levels are covered. So there are 1 to 6 tiers. The editor shows each
   tier's covers as checkboxes:
   - "Add" splits covers off into a new tier.
   - "Remove" moves its covers into the tier above it.
   - Save is refused while the invariant fails, and the message says why.

   The case view's "matching tier" lookup and the code-of-conduct derivation stay one tier per level, unchanged.
2. **The AI prompt stays free of outcomes.** A tier line is `- <title> (covers: <levels>): <description> Examples: <examples>`, with no
   outcome. The base instruction "never name a penalty" stands. The STABLE text changes, so `AI_PROMPT_VERSION` goes from 5 to 6, and
   stored reads become stale and are re-read on demand, as at every earlier prompt change. The changelog says so. "Additive" means the
   API; the prompt version is expected to move.
3. **Layer shape.** `PolicyLayer.guidelines` accepts two shapes:
   - the 0.2.1 positional `Array<{outcome}|null>`, which is still read so saved layers keep working;
   - a new whole form, `{ tiers: GuidelineTier[] }`, which replaces the code profile's tiers.

   The hub always saves the whole form. `teamNotes` is a new `POLICY_SECTIONS` entry, so audit, reset and changed-sections cover it.
   Reset works per section: guidelines reset the tiers, teamNotes reset the notes.
4. **Applying a recommendation** writes, in one versioned save:
   - the preset's `guidelines` tiers;
   - its `firstOffense`, `repeat` and `ladder`, so the principles and the enforcement match;
   - its `aiContext`;
   - the creator team note, for that choice only.

   For this, `aiContext` becomes a layer-able section, edited in the hub behind the advanced door. `levels` stays in code, since it is
   shared by all three presets, and so does `profanity`. The preview shows the tiers and a one-line summary of the ladder.
5. **The setup flag** uses a new optional Store pair, `getSetupState(): { dismissedAt: number | null } | null` and
   `saveSetupState(state)`. It exists in both stores: SQLite keeps it in kit_meta and the memory store in a field. The routes are
   `GET /setup` (owner) and `POST /setup/dismiss` (owner). When a store lacks the pair, a dismissal lasts only for the session. Any saved
   policy layer, for any section, hides the panel.
6. **`chatwarden init`** gains `--game competitive|social|kids|creator`, which maps to a preset. `--profile` stays, and wins when both
   are given. The interactive flow asks the game type first, and the JSON answers gain `game`. The creator choice writes its team note
   into the generated profile overrides.
7. **The injection screen on authored text.** It runs at save. A flagged tier field or note is a warning in the hub, never a refusal.
   When the prompt is built:
   - a flagged note is left out;
   - a flagged tier keeps only its title and covers, so every level still has a line.

   `PolicyState` gains `promptExcluded: { tiers: number[]; notes: number[] }` so the hub can show this. The cap is measured after the
   `oneLine` reduction: each tier line is at most 400 characters, and the block is at most 4,000. Tiers always fit, because 6 lines at
   400 is 2,400. Notes are dropped last first, and the hub says how many.
8. **A note's rule link** must name an existing Community Rule, active or retired, at save. A note whose rule is later retired still
   shows in the guide, but not on cases.
9. **Moxgate is out of this plan.** Moving its wording and notes is a separate Moxgate change after 0.2.2 publishes.
