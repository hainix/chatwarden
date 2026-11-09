---
status: proposed (owner + community moderator input 2026-11-09; recommendations are the defaults until answered)
updated: 2026-11-09
---

# Moderation standards: conduct levels, outcomes, and per-game profiles

## Why

A community moderator reviewing Moxgate's first real reports (2026-11-09) wrote:

> "I've been seeing a lot of reports for some level of trash talk… one player reported for calling the other
> 'loser' and another for saying 'go fuck yourself'… I don't think every rude comment or moment of frustration
> should automatically result in punishment… my main concern is consistency… we need to be able to explain
> where that line is and why… just because a report doesn't hold up doesn't mean it was made in bad faith."

The mod proposed five tiers:
1. mild trash talk: dismiss
2. one aggressive line, first offense: dismiss but keep a record
3. repeated hostility: warning
4. continued after a warning: timeouts and bans
5. threats, hate, discrimination or serious harassment: act immediately

The owner agreed:

> "I align with you on moderation being only for egregious harassment, hate speech type of cases, and let the
> trash talk slide… warnings is probably good for 'hey, be respectful'."

The owner then asked for this to be built into the kit:

> "various games are gonna have various levels of what they wanna do with it and what level of moderation, so
> we should support all of that and then let's figure out what's good for Moxgate."

What the kit does today (K2), and why that falls short:
- **The ladder's lowest first-offense step is a visible Warning.** There is no "dismiss but keep a record".
- **There is no "fair report, but within the rules" outcome.** Moderators have to choose between "unfair" and acting.
- **The AI read and the ladder share a severity scale (high/medium/low/none)** with no meaning attached. Two
  moderators can't apply it the same way.
- **Nothing tells reporters where the line is,** so trash-talk reports keep arriving.

## The idea in one line

A **moderation profile** is a game's written standard. It defines:
- what each **conduct level** means
- what happens on a first offense at each level
- what counts as "repeated"
- how the AI read is instructed

The kit then applies it consistently: the moderator's suggestion, the AI read, the hub guide, the report dialog
and a public "how we moderate" page all come from that one profile.

## Conduct levels (shared vocabulary)

These replace the unlabelled `Severity`. Every report is read as one of:

| Level | Meaning | Examples |
|---|---|---|
| `banter` | Trash talk, salt, jokes about play, profanity not aimed at a person | "ez", "bad keep", "loser", "lol you're trash at this", "damn it" |
| `rude` | A personal insult or profanity aimed at a player, isolated | "go f— yourself", "you're an idiot" |
| `hostile` | Sustained or repeated aggression: several insults, picking a fight, following someone across games | three insults in one game; insulting the same player again next game |
| `severe` | Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing, serious harassment | any slur, "I'll find you", anything about race or religion as an attack |

`Severity` in code becomes `ConductLevel = 'banter' | 'rude' | 'hostile' | 'severe'`. K2's ladder used
none / low / medium / high, which map one-to-one. Nothing is released yet, so this is renamed now, before K3's AI read
depends on it.

## Outcomes

Two additions to K2, plus clearer names:

1. **Note** (new action kind `note`). The incident goes on the player's record for staff only. The player isn't
   told and nothing is restricted. Notes count toward "repeated". This is the mod's "dismiss while keeping a record".
2. **Verdicts, renamed** to say what the moderator decided, not whether the reporter was "fair":
   - `upheld`: rules were broken and an action was taken (was `fair`)
   - `noted`: behaviour recorded as a Note, no action against the player
   - `no_action`: within the rules, e.g. trash talk (was `unfair`). It is **neutral for the reporter**: an honest
     report that doesn't hold up is never held against them.
   - `bad_faith`: there is **evidence** of deliberate abuse. It now **requires a written evidence note**, stored
     with the decision and staff-only. The Guide says plainly that a dismissed report is not bad faith.

Reporter feedback stays "action taken" on `upheld` only.

## Profiles

A profile is data. The kit ships presets, and an adopter picks one, tweaks one, or writes their own.

```ts
interface ModerationProfile {
  id: string;                         // 'relaxed' | 'standard' | 'strict' | custom
  name: string;                       // shown in the Guide and the public page
  summary: string;                    // one line players see: what's fine here, what isn't
  firstOffense: Record<ConductLevel, Outcome>;   // the first time, with a clean record
  repeat: { windowDays: number; notes: number; distinctGames: boolean };  // when notes add up to "repeated"
  ladder: LadderTable;                // escalation after a warning (K2's table, per profile)
  profanity: 'allow' | 'star' | 'refuse';        // ordinary swearing in chat (slurs are always refused)
  aiContext: string;                  // the plain-language standard given to the AI read with the Community Rules
  aiAutoAct: ConductLevel[];          // levels AI level 3 may act on by itself (never 'banter' or 'rude')
}
type Outcome = 'none' | 'note' | 'warning' | { kind: 'chat' | 'area' | 'ban'; durationMs: number | null };
```

### Presets

| | **relaxed** (competitive, adults) | **standard** (general audiences) | **strict** (younger players, family) |
|---|---|---|---|
| summary | "Trash talk is part of the game. Harassment, threats and hate are not." | "Keep it friendly. Personal insults, harassment and hate aren't allowed." | "Be kind. No swearing, insults or bullying." |
| banter | none | none | none (profanity refused) |
| rude, first | **note** | warning | warning + chat 1 h |
| hostile, first | warning | chat 24 h | chat 24 h |
| severe, first | chat 7 d → ban per ladder | chat 7 d → ban | ban 7 d |
| repeated | 2 notes in 30 d, from different games → warning | 2 notes in 30 d → chat 24 h | any note → warning |
| profanity | star | star | refuse |
| AI may auto-act on | severe | severe | hostile, severe |

After the first offense, every profile escalates through its ladder. The record step counts warnings and
restrictions as K2 does, and "repeated" turns accumulated notes into a step.

## Where it shows up

- **`suggest`** (the hub's suggested action) takes the profile, the conduct level and the record (notes included),
  and returns the profile's outcome: "none", "note", "warning" or a restriction, each with the line from the
  profile that justifies it. This gives the mod's "explain where the line is and why".
- **AI read (K3)** classifies conduct level, not "severity". Its prompt is the Community Rules plus the
  profile's `aiContext` and the table of level meanings, so under `relaxed` "loser" reads as `banter`.
- **Hub Guide (K4)** renders the profile: level meanings with examples, first-offense outcomes, the repeat
  rule, the ladder, and "a dismissed report is not bad faith".
- **Report dialog and the public `/rules/` page** show the profile `summary` above the Community Rules ("Trash
  talk is part of the game here. Report harassment, threats and hate."). That sets expectations before a report
  is filed, which is the cheapest fix for trash-talk report volume.
- **Community Rules per profile.** The starter CR 2 reads differently by profile:
  - relaxed: "No harassment or threats. Trash talk about the game and each other's play is fine; harassing,
    threatening or personally attacking someone again and again is not."
  - standard: today's text.

  Rule numbers stay the same across profiles.

## Moxgate's setting (recommended)

**`relaxed`**, exactly as the moderator described:
- "loser" and mild trash talk → no action
- one "go f— yourself" with a clean record → note
- repeated across games → warning ("be respectful")
- after a warning → timeouts, then bans
- threats, hate or discrimination → immediate

Profanity stays starred as it is today. Starring isn't punishment, just softening.

## Build order

This lands as the first part of K3, before the AI read, because the AI read is prompted from it:
1. `ConductLevel` rename, the `note` kind, verdict rename, and the bad-faith evidence note (core + both stores + facade)
2. `ModerationProfile`, the three presets, and profile-aware `suggest` with notes counting toward "repeated"
3. Profile-specific starter CR 2 text, and `profile.summary` exposed for report dialogs and pages
4. tiny-chat runs `relaxed` and shows the summary line

## Owner questions (recommended answer is the default until you say otherwise)

1. **Moxgate profile:** relaxed. *(Recommended.)*
2. **Are notes invisible to the player?** Yes. The first thing a player ever sees is a Warning. *(Recommended; matches
   "dismiss while keeping a record".)*
3. **Repeat rule for relaxed:** 2 notes within 30 days, from different games, gives a warning. *(Recommended. "Different
   games" stops one heated game counting twice.)*
4. **Profanity in Moxgate:** keep starring. *(Recommended.)* The alternative is `allow`.
5. **Bad faith needs a written evidence note:** yes. *(Recommended.)*
6. **Show the profile summary in Moxgate's report dialog:** yes. *(Recommended.)*
7. **Moxgate's CR 2 wording:** the relaxed text above. *(Recommended.)*
