---
status: draft, awaiting controller rulings (section 14)
updated: 2026-11-12
release: 0.1.7
---

# Slow mode, flood control and generic signals

Two features that share one idea: the kit already decides what to do about a line or a report once it has them; this note gives it two
more things to look at before and around that decision. **Part A** slows a room down (a minimum gap between lines, a burst limit, no
repeats) and refuses the extra lines before the term matcher ever runs. **Part B** lets a game tell the kit what its own systems see
about a player (muted by others, kicked, left mid-game) as counted, guarded, text-free signals that three places may read, each only
because a profile rule says so.

Both come from the owner's roadmap in `docs/design/2026-11-10-editable-ladder-and-roadmap.md` (Part 2), which is binding intent. This
note fills in the details against the code as it stands after 0.1.6 (triage speed in 0.1.5, AI levels 1 and 2 in 0.1.6). Store
migrations therefore start at **21**: 19 is the reporter-outcome index (0.1.5) and 20 is the AI reads and casebook (0.1.6). Two things
it builds on are not on `main` yet and are cited from their branches: triage's `cases.next` filter `rankDownHabitual` and
`REPORTER_RANK_LAPSE_MS` (`team.ts`, `reporterAccuracy.ts`), and the AI note's `AIReadInput` and `priority` sort.

## 1. Why

**Slow mode and flood control.** A busy room is the cheapest place to hurt a game's chat. Three people repeating one line, or one
person sending forty lines in ten seconds, push real conversation out of view and bury the evidence a later report will need.
Today the only throttle is the fixed anti-abuse limit in `ChatService` (`RATE_LIMIT` lines per `RATE_WINDOW_MS`, 3 per 5 s per
`roomId:seatId`, reason `rate`). It is not configurable per room, has no duplicate rule, tells the player nothing but "no", and is not a
signal that anyone can use. Tournament rooms want a deliberate slow mode, and a game that wants one has nothing to turn on.

**Signals.** The owner (2026-11-10): "add support to wire end, metrics and logging, so for example if someone is being muted by other
players, that should be a good signal that that player is probably causing issues or if they get and kick some servers or kick from the
chat, that's probably good indication, but again make it generic because everyone doesn't have the same table format or work like ours,
so build it generically so that you can add in features that will contribute to like deciding what ladder to put and what AI moderation
to take." A game knows things the kit cannot see: who muted whom, who was kicked from a table, who left a match. Those are strong
hints and weak evidence. The kit's job is to count them honestly (distinct people, not repeats), refuse the ways they are abused, and
hand the count to the three places that can use a hint, never to apply a sanction on it.

## 2. Goals and non-goals

### Goals
- Per-room pacing: a minimum interval between a player's lines, a burst limit, and duplicate-line suppression, enforced in the existing
  chat check path before the matcher, so a refused line costs nothing. Off by default.
- A refusal outcome that says why (`slow_mode`, `flood`, `duplicate`) and when to try again (`retryAfterMs`), with no text in it.
- Adopter defaults in the profile, editable in the hub under Settings, Advanced; a room override API for games.
- A flood trip records the built-in signal `flood_triggered`, at most once per window per player.
- `cw.signals.record` for the game's own signal kinds, declared once in the profile; counted over windows by distinct source; guarded
  against repeats and brigading; kept under the kit's retention settings.
- Three explicit feeds, each off until a profile rule turns it on: the Person page record, the ladder suggestion (a note or one step),
  and the AI read's case context. An optional queue-ordering boost, off by default.
- Store migration 21, in the memory and SQLite stores, with parity covered by one contract suite.

### Non-goals
- A signal never applies a sanction, never closes or opens a report, never changes what the term matcher does. It informs a human or
  nudges a suggestion that a human still sends.
- No free text on a signal. Ever.
- No chat transport and no chat box. The kit still moderates the chat the game has; this note changes what `cw.chat.accept` answers.
- No shared (cross-process) pacing state. See section 4.6.
- No signals from outside the process in this release (no incoming-webhook action; section 12).
- No assumption about any game's tables, rooms, seats or accounts. Moxgate's own signals (`muted_by_player`, `kicked_from_room`,
  `left_mid_game`, `blocked_by_player`) appear in this note only as examples of what an adopter might declare.

## 3. Rulings (decided; the details below follow from them)

1. **Ruling: Pacing is three independent settings, all unset by default.** `slowModeMs`, `burst` and `duplicateWindowMs` are each `null`
   (off) until set. A kit that sets none behaves byte for byte as 0.1.6 does. The existing fixed limit (3 lines per 5 s per seat,
   reason `rate`) stays exactly as it is, underneath.
2. **Ruling: The refusal is a new reason, not a new result shape.** `RefuseReason` gains `'slow_mode' | 'flood' | 'duplicate'`, and the
   `refuse` arm gains an optional `retryAfterMs`. `ChatResult` still has exactly two arms, so existing `'deliver' in r` code keeps
   working; only an exhaustive `switch` over `reason` needs a new case, and it can only ever see the new reasons after the adopter
   turns pacing on.
3. **Ruling: Pacing runs after the restriction and length checks and before `rate`, and it commits only when the line gets past `rate`.** A
   refused line writes nothing and spends no budget. The line a refusal names is never stored, buffered, struck or reported.
4. **Ruling: State is in memory, per process, keyed by room and person.** No store write per line. The cost is stated in section 4.6.
5. **Ruling: A flood trip (reason `flood`) records the built-in kind `flood_triggered`**, at most once per burst window per player per room,
   deferred out of the verdict. Slow mode and duplicate refusals are ordinary and record nothing.
6. **Ruling: Signal kinds are the adopter's strings, declared in code.** Each has a label, a polarity (`negative` | `positive`) and a default
   weight. The set of kinds is code-only (like profanity); the rules that read them (the feeds) are editable by the owner in the hub.
   An undeclared kind is refused: `record` returns `false` and never throws.
7. **Ruling: Signals are counted by distinct source, not by row.** A source is the `by` player when there is one, otherwise the room, otherwise
   the UTC day. One grudge cannot count ten times.
8. **Ruling: Guards are exactly three:** distinct sources (above); a per-`by` cap per subject per kind per window (default one a day); and
   new-account weighting only when the adopter supplies an account-age hook (otherwise it is not used at all).
9. **Ruling: Three feeds, each only by an explicit profile rule.** The record (lines on the Person page), the ladder (a note or one step
   up, never an action) and the AI read (counts as context, nothing else). The queue boost is part of a fourth, optional, off-by-default
   rule and is capped.
10. **Ruling: Positive signals can inform; they cannot raise anything.** A rule that raises a suggestion or boosts the queue may name only
    negative kinds. Lowering a suggestion because of a positive kind is not in this release.
11. **Ruling: Nothing here is a ceiling.** The AI ceilings stand as written in the AI note (section 8 there): other players' flags never count
    on their own. The AI feed changes what the model is told, not what it is allowed to do; section 5.7 states the one amendment to that
    note's data-minimisation list.

## 4. Part A: pacing

### 4.1 The settings and where they live

A new optional profile field, `pace`, in the base profile (code), editable as a stored layer section like `reporting`:

```ts
// packages/core/src/pace.ts (new)

export const PACE_REASONS = ['slow_mode', 'flood', 'duplicate'] as const;
export type PaceReason = (typeof PACE_REASONS)[number];

/**
 * How a room paces a player's lines. Every field optional on input; `null` or absent is off.
 * @experimental
 */
export interface PaceSettings {
  /** The least time between one player's lines in a room, ms. 500 to 600 000. */
  slowModeMs?: number | null;
  /** At most `lines` lines in any `windowMs`. `lines` 2 to 100, `windowMs` 1 000 to 600 000. */
  burst?: { lines: number; windowMs: number } | null;
  /** The same normalized line again inside this many ms is refused. 1 000 to 3 600 000. */
  duplicateWindowMs?: number | null;
}

/** What the kit reads: every field filled, `null` meaning off. @experimental */
export interface ResolvedPace {
  slowModeMs: number | null;
  burst: { lines: number; windowMs: number } | null;
  duplicateWindowMs: number | null;
}

/** Values the hub offers behind "Use suggested values". Never applied by themselves. @experimental */
export const PACE_SUGGESTIONS: Readonly<Record<'relaxed' | 'standard' | 'strict', ResolvedPace>>;

/** Validate and fill. Throws ProfileError naming the field (`pace.burst.lines`), never echoing the value. @experimental */
export function resolvePace(input: PaceSettings | undefined, path?: string): ResolvedPace;
/** `over` on top of `base`: a field left out inherits, `null` turns it off. @experimental */
export function mergePace(base: ResolvedPace, over: PaceSettings): ResolvedPace;
```

`profile.ts` changes: `TOP_KEYS` gains `pace`; `ModerationProfile.pace?: PaceSettings`; `ResolvedProfile.pace: ResolvedPace`;
`PolicyLayer.pace?: PaceSettings`; `POLICY_SECTIONS` gains `'pace'` (appended after `'ai'`, which 0.1.6 added). The three presets
(`relaxed`, `standard`, `strict`) ship `pace` unset, so **no existing install changes**. `PACE_SUGGESTIONS` is what the hub's "Use
suggested values" button fills in, never written by itself:

| Preset | slow mode | burst | duplicate |
| --- | --- | --- | --- |
| relaxed | off | 10 lines in 10 s | 10 s |
| standard | off | 6 lines in 10 s | 15 s |
| strict | 2 s | 5 lines in 10 s | 30 s |

**Precedence, highest first:** a room override (4.5), the stored layer, the base profile (code), off. `cw.profile.pace` is the third
and second merged; the room override is applied per call.

Validation notes: a burst whose rate is looser than the fixed limit (`limits.chatRate`, default 3 per 5 s) can never trigger, because
`rate` bites first inside the same window. The kit does not refuse such a setting (the fixed limit is itself configurable); the hub
shows a one-line hint beside the field ("The built-in limit of 3 messages per 5 seconds applies first").

### 4.2 The check, in order

`ChatService.run` (`packages/core/src/chat.ts`) today goes: trim; occupant and gate; restriction; length; `rate`; matcher; profanity;
buffer. Pacing slots in after `length` and before `rate`:

```
 1. trim; empty                       -> 'empty'
 2. occupant, gate                    -> 'gate'
 3. active restriction                -> 'restricted'
 4. length > max                      -> 'length'
 5. PACE (new, read only)             -> 'slow_mode' | 'flood' | 'duplicate'
 6. rate (spent even if then blocked) -> 'rate'
 7. PACE COMMIT (new)                 -- only now: the line counts toward the next check
 8. matcher, profanity, buffer        -- unchanged
```

Why before `rate`: the specific, retryable message wins over the blunt one, and a player hammering a slow-mode room sees "slow mode",
not "rate". Why commit after `rate`: a line `rate` refuses never happened as far as pacing is concerned, so neither check can starve the
other. A line the matcher then blocks has still committed (it spent its slot), exactly as the existing rule says it spends its `rate`
budget, so a flood of blocked lines cannot probe the term list faster than ordinary chat.

Within step 5 the checks run in a fixed order and the first refusal wins: `slow_mode`, then `flood`, then `duplicate`.

- **slow_mode.** Refuse when `now - lastAt < slowModeMs`; `retryAfterMs = lastAt + slowModeMs - now`.
- **flood.** The player's committed line times inside the last `burst.windowMs`; refuse when there are already `burst.lines` of them;
  `retryAfterMs = oldest + windowMs - now`.
- **duplicate.** Normalize the line (NFKC, lower-case, keep letters and digits only). A normalized line shorter than
  `DUPLICATE_MIN_CHARS` (3) is never a duplicate, so "gg" and "ok" stay free. A hash of it (the kit's own digest in `crypto.ts`,
  truncated; never the text) is compared with the player's last eight in-window hashes. A match refuses with
  `retryAfterMs = at + duplicateWindowMs - now`. A refused duplicate does not refresh its `at`, so repeating a line cannot extend its own
  block.

A refusal never changes pacing state (the same arithmetic as `slidingWindow`: a refused hit is not recorded).

**The key.** `roomId` plus the seat occupant's canonical subject; for a guest with no subject, `roomId` plus the seat id. A player in
two rooms has two independent states. Re-seating a known player does not reset anything; a guest who reconnects into a new seat does,
which is a limit of guests, not of pacing.

**Memory.** State per key is `{ lastAt, stamps (at most burst.lines), recent (at most 8 hashes), floodSignalAt }`, held in a map of
maps by room so `cw.rooms.close(roomId)` drops a whole room in one delete. Quiet keys are swept on the same fixed cadence as
`slidingWindow` (every 256 calls), against the longest window currently configured, and total keys are capped (50 000; the oldest go).
Changing a setting takes effect on the next line with no restart: the service reads the settings through a function, not a copy.

### 4.3 The result

```ts
// packages/core/src/chat.ts
export type RefuseReason =
  | 'empty' | 'length' | 'rate' | 'gate' | 'restricted' | 'blocked' | 'profanity'
  | PaceReason;                                   // 'slow_mode' | 'flood' | 'duplicate'

export type ChatResult =
  | { deliver: { lineId: string; text: string } }
  | {
      refuse: {
        reason: RefuseReason;
        until?: number | null;
        byModerator?: boolean;
        rule?: number;
        noticeId?: string;
        /** Present for slow_mode, flood and duplicate: when the same player may try again, ms from now (at least 1). */
        retryAfterMs?: number;
      };
    };
```

A pacing refusal carries a reason and a wait. No `rule`, no `noticeId` (it is not a sanction), no text, no identifier.

### 4.4 `flood_triggered`

When the verdict is `flood`, `ChatService` calls an optional `pace.onFlood({ roomId, subject })` dep, at most once per
`burst.windowMs` per key (tracked in the key's `floodSignalAt`), and only for a known subject. The facade implements it by deferring
(`queueMicrotask`) a `signals` write of the built-in kind, so the verdict is returned first. A failure is logged by event name and error
class and absorbed, like the strike write beside it. The row is also capped by the signal store's own per-source cap (section 5.4: one
per room per day for a source-less kind), so a player who floods ten rooms leaves ten rows, not ten thousand.

### 4.5 The room override API

For a tournament room, a quiet room, a room that is read-only for new players:

```ts
// on Chatwarden['rooms']
/**
 * Pace this room differently from the defaults until it closes. Per field: absent inherits, `null` turns that check off, a value sets it.
 * `null` instead of an object removes the override. Throws ProfileError for an invalid value (a setup mistake, not a hot-path call).
 * In memory, this process only; `rooms.close(roomId)` drops it. @experimental
 */
setPace(roomId: string, pace: PaceSettings | null): void;
/** The pace in force for the room: defaults with the override applied. @experimental */
pace(roomId: string): ResolvedPace;
```

```ts
cw.rooms.setPace('tournament:final', { slowModeMs: 3000, burst: { lines: 3, windowMs: 10_000 } });
cw.rooms.setPace('tournament:final', null);                       // back to the defaults
cw.rooms.setPace('practice', { slowModeMs: null, burst: null, duplicateWindowMs: null }); // no pacing here at all
```

An override lives in this process, like the seats and the evidence buffer it sits beside. A game that runs several processes calls
`setPace` where it creates the room, in each process that serves it.

### 4.6 What it means for several processes

All pacing state is per process and lost on restart. That is the same property the fixed `rate` limit has today, and it is stated, not
hidden:

- A game that keeps one room's connections on one process (the usual websocket arrangement) gets the full effect.
- A game that sends one player's lines to random processes gets up to N times the limit (N processes), and a restart empties the slate.
- Nothing is shared and nothing is written, by design: a store round trip per line is exactly the cost this feature exists to avoid.
- The advice, in the README and in the Settings help text: route a room's chat to one process, or accept the looser effective limit.

### 4.7 Player UI and words

player-react has no chat box (it moderates the chat the game already has). The existing place for "you cannot type right now" is
`RestrictedChatLine` (`packages/player-react/src/RestrictedChatLine.tsx`), built for a sanction with an end time. It gains one optional
prop, and `until` and `byModerator` become optional (a widening: every existing call still type-checks):

```ts
export interface RestrictedChatLineProps extends PlayerUiProps {
  until?: number | null;           // was required: used when not pacing
  byModerator?: boolean;           // was required: used when not pacing
  refCode?: string;
  /**
   * A pause, not a sanction: pass the refusal's `reason` and `retryAfterMs`. When given it replaces `until`/`byModerator`, draws no
   * referee card, and says how long to wait in seconds. @experimental
   */
  pace?: { reason: 'slow_mode' | 'flood' | 'duplicate'; retryAfterMs: number };
}
```

The game's client takes `reason` and `retryAfterMs` from the refusal its own server relays. The line works out the end once, on first
render (`ui.now() + retryAfterMs`), so a re-render does not restart it. It is a status line, not a live countdown; the game hides it
when it lets the player type again. `timeLeft` in `format.ts` rounds up to whole minutes, which is wrong for a 3 second wait, so
`format.ts` gains a sibling `secondsLeft(ms, locale)` (whole seconds up to 120, then it defers to `timeLeft`).

New words (all in the flat `en` catalog; other locales follow, and a missing key falls back to English):

| Key | English |
| --- | --- |
| `player.pace.slow_mode` | Slow mode is on. You can send another message in {left}. |
| `player.pace.flood` | You are sending messages too fast. Try again in {left}. |
| `player.pace.duplicate` | You already sent that. Say something different, or try again in {left}. |
| `player.pace.wait.one` / `.other` | {count} second / {count} seconds |

The copy follows the catalog's rules: second person, sentence case, plain words, never shaming. `size.test.ts` (the player-react bundle
budget) is re-checked.

### 4.8 Hub UI

Where it lives, per the advanced-door rule: **Settings, then a new section "Advanced"**, a panel "Slow mode and flooding". Nothing is
added to the queue, the case card, the top bar or Simple mode. In Simple, Settings is reached as today (More); the Advanced section
appears in the settings section list only for roles with `policy.read`.

Why a new section and not the "Steps and ladder" or "Reporting" screens: those are about what happens after a report. Advanced is the one
disclosure for everything that is power rather than daily use; 0.1.8 adds its appeals and names panels there (the next design note), and the AI
note's own "Advanced" disclosure stays inside its AI section.

The panel (owner edits; seniors and moderators read):

- **Slow mode:** off, or a number of seconds.
- **Burst:** off, or "N messages in W seconds".
- **Repeats:** off, or a number of seconds.
- A "Use suggested values" button (fills the form from `PACE_SUGGESTIONS` for the profile's preset; saving is still explicit).
- The one-line hint about the built-in limit, and one line saying the settings apply per process and to every room unless the game
  overrides a room.

It uses the existing policy screen machinery (`policy/` hooks `useSaveFlow`, `useResetFlow`, `useDraftSync`, `useUnsavedGuard`, the
`SaveBar`): a local draft, a reason on save, version conflicts offered a reload, a per-section reset. Router change:
`SettingsSection` gains `'advanced'`; `SETTINGS_SECTIONS` and the `SECTIONS` list in `screens/Settings.tsx` gain one entry, lazily loaded
(`screens/lazy.tsx`).

Strings: `hub.settings.advanced.nav` "Advanced", `hub.settings.pace.title` "Slow mode and flooding", plus the field labels and the two
hint lines, all through `t()`.

### 4.9 Routes

No new route. The settings travel in the existing profile routes:

- `GET /policy/profile` returns `effective.pace` (and `base.pace`, `layer.pace`) because they are part of the profile.
- `PUT /policy/profile` accepts `layer.pace`. A bad value is 400 `invalid_profile` with the path in the layer
  (`layer.pace.burst.lines`). `policy.write` (owner) as today.
- `DELETE /policy/profile?section=pace` resets it (the section name is added to the accepted list).

### 4.10 Audit

Saved like any policy edit: `policy.update` / `policy.reset` with `detail: { sections: ['pace'], reason }`. Section names, never values.
**No new audit action** for pacing. A refused line is not audited (hot path; it would be a row per line).

## 5. Part B: signals

### 5.1 Declaring them

```ts
// packages/core/src/signals.ts (new)

export type SignalPolarity = 'negative' | 'positive';

/** One kind a game declares. The key in `kinds` is the id the game passes to `record`. @experimental */
export interface SignalKindSpec {
  /** What staff read: "Muted by other players". Plain text, 1 to 60 characters, no markup. Also the label the AI feed sends. */
  label: string;
  polarity: SignalPolarity;
  /** Default weight of one source, 0 to 10, default 1. A record may override it per call. */
  weight?: number;
}

/** @experimental */
export interface SignalGuards {
  /** At most one row per (kind, subject, source) per this many ms. Default 86 400 000 (one day). 60 000 to 30 days. */
  perByWindowMs?: number;
  /** Used ONLY when the adopter supplies `signals.accountAgeDays` to createChatwarden. Default: not set (no weighting). */
  newAccount?: { belowDays: number; factor: number };       // belowDays 1..365, factor greater than 0 and at most 1
}

/** One threshold, over distinct sources, in a window. @experimental */
export interface SignalThreshold {
  kinds: string[];                 // declared kinds, 1 to 8
  minDistinct: number;             // 1 to 50 distinct sources with weight above 0
  windowDays: number;              // 1 to 90, and not above retention.signalsMs
  minWeight?: number;              // the sum of those sources' weights must also reach this
}

/** The feeds. Absent means that feed is off. @experimental */
export interface SignalFeeds {
  /** Lines on the Person page record. `'*'` means every declared kind. */
  record?: { kinds: string[] | '*'; windowDays: number };
  /** Queue ordering: a person who meets the threshold ranks ahead of older ordinary cases, capped (section 5.5). Negative kinds only. */
  queue?: SignalThreshold;
  /** The ladder. `note` adds a sentence to the suggestion; `raise` moves it up one step (section 5.6). `raise` takes negative kinds only. */
  ladder?: Array<SignalThreshold & { id: string; effect: 'note' | 'raise' }>;
  /** The AI read's case context (section 5.7). */
  ai?: { kinds: string[] | '*'; windowDays: number };
}

/** @experimental */
export interface SignalSettings {
  kinds?: Record<string, SignalKindSpec>;     // code only
  guards?: SignalGuards;                      // code only
  feeds?: SignalFeeds;                        // editable in the hub
}

/** Kinds the kit declares itself. An adopter may relabel or re-weight one by declaring the same key; the polarity must stay negative. */
export const BUILTIN_SIGNAL_KINDS: Readonly<Record<'flood_triggered', SignalKindSpec>>;
```

A kind id is a lower-case slug (`^[a-z][a-z0-9_]{0,39}$`), at most 40 declared kinds. `profile.ts` changes: `TOP_KEYS` gains `signals`;
`ModerationProfile.signals?: SignalSettings`; `ResolvedProfile.signals` (kinds merged with the built-ins, guards filled, feeds as
given); `POLICY_SECTIONS` gains `'signals'` after `'pace'`. A layer's `signals` may hold **only `feeds`**
(`PolicyLayer.signals?: { feeds?: SignalFeeds }`); a layer that names a kind, a guard or anything else is refused with its path, and a
feed that names an undeclared kind is refused (`layer.signals.feeds.queue.kinds[0]`). The presets ship `signals` unset: no kinds, no
feeds, nothing on any page.

Moxgate-shaped examples, to show the shape and nothing more:

```ts
signals: {
  kinds: {
    muted_by_player:   { label: 'Muted by other players', polarity: 'negative' },
    blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' },
    kicked_from_room:  { label: 'Kicked from a room', polarity: 'negative', weight: 2 },
    left_mid_game:     { label: 'Left mid-game', polarity: 'negative', weight: 0.5 },
    commended:         { label: 'Commended by other players', polarity: 'positive' },
  },
  feeds: {
    record: { kinds: '*', windowDays: 14 },
    ladder: [{ id: 'muted-a-lot', kinds: ['muted_by_player', 'blocked_by_player'], minDistinct: 5, windowDays: 14, effect: 'note' }],
  },
}
```

### 5.2 Recording

```ts
/** Who a signal is about or from: a staff-side subject id (`cw.rooms.subjectAt`), or the raw identity the game already passes to the doors. */
export type SignalParty = SubjectId | RawWho;

/** @experimental */
export interface SignalInput {
  /** A declared kind (or a built-in). */
  kind: string;
  /** Whom it is about. */
  subject: SignalParty;
  /** Who produced it (the player who muted, the player who left). Omit for a source the game itself is, such as a timeout. */
  by?: SignalParty;
  /** The game's own room id: 1 to 64 characters of A-Z a-z 0-9 _ . : - . Not player text. */
  roomId?: string;
  /** When it happened, epoch ms. Default: now. Not more than 5 minutes ahead, not older than retention.signalsMs. */
  at?: number;
  /** Overrides the kind's default weight for this one record. 0 to 10. */
  weight?: number;
}

// on Chatwarden
signals: {
  /**
   * Record one signal. Synchronous, fenced, never throws: it returns false (and logs `chatwarden.signal_refused` with a reason code, at
   * most once a minute) for an undeclared or malformed kind, a party it cannot resolve, `subject` equal to `by`, a time out of range, the
   * per-source cap, a store without signals, or a store failure. True means a row was written.
   * One small write: record events, not every chat line. @experimental
   */
  record(input: SignalInput): boolean;
  /**
   * The counts for a person now: one entry per declared kind that has at least one source in the window, aliases folded. For staff
   * tooling and your own game; never send to a player. Never throws; a store failure reads as []. @experimental
   */
  counts(subject: SubjectId, opts?: { windowDays?: number; kinds?: readonly string[] }): SignalCount[];
  /** The declared kinds, built-ins included, for building a form. @experimental */
  kinds(): SignalKindView[];
};

/** @experimental */
export interface SignalCount {
  kind: string;
  label: string;
  polarity: SignalPolarity;
  /** Distinct sources with weight above 0 in the window. */
  distinct: number;
  /** The sum of those sources' weights. */
  weight: number;
  windowDays: number;
  firstAt: number;
  lastAt: number;
}
/** @experimental */
export interface SignalKindView { kind: string; label: string; polarity: SignalPolarity; weight: number; builtin: boolean }
```

`ChatwardenOptions` gains one optional hook, used by the third guard only:

```ts
signals?: {
  /**
   * How old is this player's account, in days, from the account ids the kit has for them (the strings your game gave it as
   * `RawWho.accountId`)? Return null or undefined when unknown. Called synchronously at record time for `by`; a throw reads as unknown
   * (logged by error class). Without this hook the new-account guard is not used, whatever the profile says. @experimental
   */
  accountAgeDays?: (accountIds: readonly string[]) => number | null | undefined;
};
```

Resolving a party: a string is a subject id, made canonical (`SubjectIndex.canonical`); an object is looked up with the facade's
`personOf` (find, never create), so a stranger the kit has never seen is refused (`unknown_subject`) rather than created. The kit never
records a signal about itself.

### 5.3 Counting

Two distinct-source rules decide what a "count" means; they are the heart of the guard against grudges:

- **The source key** of a row is `b:<canonical by>` when there is a `by`; otherwise `r:<roomId>` when there is a room; otherwise
  `d:<UTC day>`. A thousand mutes from one player are one source. A source-less `left_mid_game` in one room all day is one source.
- **The effective weight** stored on the row is `(given weight or the kind's default) x newAccountFactor`, where the factor is
  `guards.newAccount.factor` only if the hook is supplied, returns an age, and the age is below `belowDays`; otherwise 1. It is
  computed once, at record time, and stored, so changing a guard later does not rewrite history.

A count over a window is: group the person's rows (and their merged aliases', folded to the canonical `by`) by source key; within a
source take the highest weight; drop sources whose weight is 0; `distinct` is how many remain and `weight` is their sum. A
threshold is met when `distinct >= minDistinct` and, if `minWeight` is given, `weight >= minWeight`. For a threshold over several
kinds, sources are taken per kind and the two numbers are summed across the kinds, so one player who both muted and blocked counts
twice for "muted or blocked"; use one kind per threshold when that matters.

### 5.4 Guards, in detail

1. **Distinct sources.** Above. A threshold of five means five different players (or rooms, or days for source-less kinds).
2. **The per-source cap.** At most one row per `(kind, subject, source key)` per `perByWindowMs` (default one day). It is enforced by a
   unique index on `(kind, subject_id, source_key, cap_bucket)` with `cap_bucket = floor(at / perByWindowMs)`, so two processes cannot both
   write the second row and a script cannot grow the table. The refused second record returns `false` (reason `capped`).
3. **New-account weighting.** Optional, only with the hook (5.2). A brand-new account's mute counts for a fraction of one; it never
   counts for more than one.
4. **A player cannot signal themselves.** `subject` and `by` that resolve to the same canonical person are refused.

What these do not stop: five real accounts that agree to mute one player. That is why a signal never acts on its own (section 3,
ruling 9), why the Person page line shows when the sources were (`firstAt`, `lastAt`: "5 players, all within 2 hours" reads
differently from "5 players over 12 days"), and why the queue boost is capped and bounded by waiting time (5.5).

### 5.5 Feed 1: the Person page record, and the queue boost

**The record.** When `feeds.record` is set, `GET /people/:ref/history` (`reports.ts`, already audited as `history.view`) gains
`signals: SignalCount[]` for the chosen kinds and window. The Person page (`screens/Person.tsx`) shows them as plain lines inside the
existing **Timeline** panel's footer, in the same style as a timeline entry without a referee card: "Muted by other players: 5 (last 14
days)". No badge, no colour, no new panel, no change to the case card or to Simple mode (whose record is one sentence). When
`feeds.record` is unset the route body is identical to today's.

**The boost.** When `feeds.queue` is set, two things change, both capped and neither hiding a case:

- `GET /reports` items gain `boosted?: true` for a person who meets the threshold. The hub's `priority` sort (AI note, section 9, "Queue ranking") adds
  `signalBoost = 0.5` to a boosted group's score, the same clamp as its `reporter` term, through a second pure seam,
  `signals.conduct?: (g: QueueGroup) => number`, beside `reporter`. The default sort and the chip set are untouched; nothing is shown.
- Take-next (`cw.cases.next`, `team.ts`) gets a second, experimental filter next to triage's `rankDownHabitual`:
  `signalBoost?: boolean`. The scan stays oldest first. The first case that is **overdue** (some open report has waited
  `REPORTER_RANK_LAPSE_MS`, 24 hours) or **boosted** is claimed; if the scan ends (the queue, or `SIGNAL_BOOST_SCAN_MAX` = 200
  people) with neither, the oldest free case is claimed, as now. Because the queue is oldest first, an overdue case is always met before
  anything newer, so a stream of boosted cases cannot starve an old one. A boosted case is never ranked down as a habitual reporter's. The
  http route (`teamRoutes`, `POST /cases/next`) passes `signalBoost: true` when the feed is on, as it passes `rankDownHabitual: true`
  today.

One grouped store read serves a page of people (`listSignalSources` with all of them), the way reporter accuracy serves a page of
reporters.

### 5.6 Feed 2: the ladder

`feeds.ladder` is a list of rules. For a reported incident the facade (`cw.suggest`, `chatwarden.ts`) computes which rules the reported
person meets and hands the pure `suggest()` (`ladder.ts`) a list of hits in its context:

```ts
export interface SignalHit { id: string; effect: 'note' | 'raise'; text: string }   // text: "Muted by other players: 5 players in 14 days"
export interface SuggestContext { roomId?: string | null; /** Set by the facade; ignored if passed to cw.suggest. */ signals?: readonly SignalHit[] }
export interface Suggestion {
  outcome: Outcome; label: string; why: string;
  /** Present only when a signal rule fired. @experimental */
  signals?: { raised: boolean; ids: string[] };
}
```

- **note.** The sentence is appended to `why` ("Also: Muted by other players: 5 players in 14 days."). The outcome is unchanged.
- **raise.** The suggestion becomes the stronger of the current pick and the ladder cell one step further down the same column
  (`min(recordStep + 1, 5)`), with `why` saying so. It is skipped, leaving only the note, when the cell is a permanent sanction or the record is
  already at step 5. So a signal can never produce a permanent ban, and never more than one step.
- `banter` returns before any of this, as it does today: signals never turn banter into action. An incident with no reported conduct
  has no suggestion at all, so a signal never starts a case.
- Everything downstream is unchanged: the hub shows `why` as it does, a moderator still picks, the decision still goes through
  `decide`. A `policy.preview` with sample records has no signals, so previews are unchanged.

### 5.7 Feed 3: the AI read (0.1.6)

When `feeds.ai` is set and the AI is on, the case context the model sees gains one block about the reported person (P1) only, in the
variable part of the prompt, after the cached prefix:

```ts
// added to AIReadInput (0.1.6, core/src/ai) under promptVersion 2
signals?: Array<{ label: string; polarity: 'negative' | 'positive'; distinct: number; windowDays: number }>;
```

Rendered as, for example: `Context about P1, not evidence: Muted by other players: 5 distinct players in 14 days.` Nothing else
leaves the process: no `by`, no room, no times, no weights, no kind ids, no row. The labels are the adopter's own short strings
(validated to 60 plain characters at declaration), which is why they are declared in code.

What this changes in the AI note, and what it does not:

- **Amends section 8, "What is never sent".** That list says "any count of flags, mutes or reports" is never sent. With an explicit
  `feeds.ai` rule, the declared signal counts above are sent, and only those. Report counts, reporter accuracy and history still never
  are. The settings help text for the AI section says so.
- **The stable prefix gains one paragraph** (always present, so turning the feed on or off never changes the cache): signal counts are
  background about the player, never evidence of the behaviour in the lines, and cannot by themselves justify a verdict above
  `unclear`. `promptVersion` becomes 2; open reads are marked stale as that note already describes for a rules edit.
- **The ceilings are untouched.** A recommendation to act still needs a cited line from the reported person (row 3 of the ceiling
  table); that check does not read signals.
- **The invalidation hash does not include the signal block.** Counts move all day; keying the hash on them would re-read every open
  report every time someone muted someone. The block is a snapshot taken when the read is made, and "Read again" takes a new one. The
  read row records what was shown in a new nullable column (migration 21): `kit_ai_reads.signals_json`, label, polarity, distinct and
  window only, shown in the case's AI details ("Context included: 2 signal counts").
- Casebook examples do not carry signals.

### 5.8 Store and migration 21

New optional `Store` methods, synchronous like claims and the policy layer; implemented in `store-memory` and `store-sqlite` and covered
by one shared contract suite, `test/contract/signals.contract.ts`. A store without them cannot keep signals: `createChatwarden` throws a
plain message when the profile declares kinds or feeds (an explicit opt-in that would otherwise silently do nothing), and treats the
built-in `flood_triggered` as skipped (logged once) when the adopter only turned pacing on.

```ts
// packages/core/src/types.ts
export interface SignalRow {
  id: string; kind: string; subject: SubjectId;
  /** 'b:<canonical by>' | 'r:<roomId>' | 'd:<UTC day>' */
  sourceKey: string;
  bySubject: SubjectId | null; roomId: string | null;
  at: number; weight: number;
  /** floor(at / perByWindowMs): the cap bucket. */
  capBucket: number;
}
export interface SignalSourceRow {
  subject: SubjectId; kind: string; sourceKey: string; bySubject: SubjectId | null;
  /** The highest weight among the source's rows in range. */
  weight: number; firstAt: number; lastAt: number;
}
// on Store
/** OPTIONAL. Insert; false (nothing written) when the (kind, subject, sourceKey, capBucket) row exists. One atomic statement. */
insertSignal?(row: SignalRow): boolean;
/** OPTIONAL. One row per (subject, kind, sourceKey) with a row at or after `since`, for these subjects (a person's canonical id and aliases). Empty list: []. */
listSignalSources?(subjects: readonly SubjectId[], since: number): SignalSourceRow[];
/** OPTIONAL. Delete rows with `at < before`; returns how many. */
purgeSignals?(before: number): number;
```

SQLite **migration 21** (append only; the runner wraps it in one savepoint with the version bump):

```sql
CREATE TABLE kit_signals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  by_subject  TEXT,
  room_id     TEXT,
  at          INTEGER NOT NULL,
  weight      REAL NOT NULL CHECK (weight >= 0),
  cap_bucket  INTEGER NOT NULL
);
CREATE UNIQUE INDEX kit_signals_cap        ON kit_signals (kind, subject_id, source_key, cap_bucket);
CREATE INDEX        kit_signals_by_subject ON kit_signals (subject_id, at);
CREATE INDEX        kit_signals_by_at      ON kit_signals (at);
ALTER TABLE kit_ai_reads ADD COLUMN signals_json TEXT;    -- the counts the model was shown; null otherwise (needs migration 20)
```

The `ALTER` is the one coupling to 0.1.6. If release order ever changes so that 20 is not present, that line moves to a later migration;
nothing else in this note depends on the AI tables. The memory store keeps the same rows in a map keyed by the unique tuple, so parity
is observable through the contract suite (cap, listing, purge, alias folding).

The grouped read the store answers is `SELECT subject_id, kind, source_key, by_subject, MAX(weight), MIN(at), MAX(at) ... WHERE
subject_id IN (...) AND at >= ? GROUP BY subject_id, kind, source_key`, served by `kit_signals_by_subject`. Rows are bounded by the
cap (one per source per kind per day), so the result is bounded by distinct sources, not by volume.

### 5.9 Retention

- New retention field `signalsMs`, default **90 days** (the ladder lookback and the record window), added to `RetentionPolicy`,
  `RETENTION_DEFAULTS` and `FIELDS` in `retention.ts`.
- **Floor: 14 days.** `checkRetentionFloors` refuses less ("a counting window needs at least two weeks of rows").
- **Cross-check:** a feed whose `windowDays` is longer than `signalsMs` is refused, at creation (`ProfileError` at
  `profile.signals.feeds.ladder[0].windowDays`) and on a layer save (400 `invalid_profile`, path `layer.signals.feeds...`), because it
  could never be met. Feed windows are capped at 90 days.
- `purge()` deletes rows with `at < now - signalsMs` in its existing transaction; `PurgeResult` gains `signals`. Cutoff strict, like the
  others. Counts and the contract tests agree on the strict edge.
- The built-in `flood_triggered` rows follow the same field. Nothing about a signal outlives it: no copy in the audit trail, the casebook
  or a webhook.

## 6. Hub UI for signals (behind the same door)

Settings, Advanced, a second panel **"Signals"**. Visible to roles with `policy.read`; edited by the owner.

- **Declared kinds (read only):** label, polarity, default weight, and "Declared in your game's code". The hub cannot invent a kind,
  because a kind is a promise that the game records it.
- **Where signals are used (editable):** four small forms, each off until switched on, each with its own words in plain language:
  1. "Show on a person's record": which kinds (or all), how many days.
  2. "Put these people sooner in the queue": which negative kinds, at least N players in D days.
  3. "Add to the suggested step": a short list of rules, each: which kinds, N players, D days, and "add a note" or "suggest one step
     higher".
  4. "Give the AI read as background" (shown only when the AI is available): which kinds, how many days.
- The same save machinery as pacing: a draft, a reason, conflict handling, reset per section.
- An honest sentence under the forms: "A signal never acts on its own. A person always decides."
- Strings: `hub.settings.signals.*` and `hub.person.signals.*`, through `t()`. Colour is not used; polarity is words ("counts against",
  "counts for"), because the hub's palette is reserved for meaning it already has.

Nothing else in the hub changes. Simple mode gets **nothing new** in this release: the owner's rule is at most one new thing, and
only if a moderator needs it most of the time. A moderator does not need signals most of the time; the Person page and the suggestion's
own sentence are enough.

## 7. HTTP summary

No new staff route and no new player route.

| Route | Change |
| --- | --- |
| `GET /policy/profile`, `PUT /policy/profile`, `DELETE /policy/profile?section=` | `pace` and `signals` are sections; invalid values are 400 `invalid_profile` with the layer path |
| `GET /people/:ref/history` | `signals: SignalCount[]` when `feeds.record` is set |
| `GET /reports` | `boosted: true` on a person meeting `feeds.queue` |
| `POST /cases/next` | passes `signalBoost: true` when `feeds.queue` is set |
| `POST /reports/:id/suggest`, `GET /reports/:id` | the `suggest` body may carry `signals` and the signal sentence in `why` |

With pacing off and no signals configured, **every response body is byte for byte what 0.1.6 sends** (a snapshot test pins it).

## 8. Audit, events, webhooks

- **Audit actions added: none.** Edits are `policy.update` and `policy.reset` with the section names `pace` and `signals`. Reads of
  signals ride the existing `history.view` on the Person page. A refused line and a recorded signal are not staff actions and are not
  audited (a row per line or per event would swamp the trail).
- **Events: none added.** `flood_triggered` is a stored signal, not an event. A game that wants to react to a flood already has the
  refusal in its own hand.
- **Webhooks and Discord: no change.** No signal, count or pace value is in any outgoing body.

## 9. Privacy and logs

- A pacing refusal carries a reason and a wait, nothing else. Pacing state is the time stamps and a truncated digest of the normalized
  line, in memory; no line text is kept for it.
- A signal row holds a kind id, ids the kit already holds (subject, `by`, a game room id), a time and a weight. **No free text, no chat
  text, no handle, no seat.** `roomId` is validated to a short id charset, not text.
- Logs carry event names and error classes or reason codes only: `chatwarden.signal_refused { reason }`,
  `chatwarden.signal_failed { error }`, `chatwarden.pace_failed { error }`. Never a subject id, a `by`, a room id, a kind id, a label
  or a line. The refusal log is throttled (`ThrottledWarn`, one a minute with a held count) so a game that records a bad kind in a loop
  cannot flood the log.
- The AI feed sends labels and counts of the reported person only, under an explicit rule, and records what it sent (5.7).
- A signal is staff-only data. No player route reads it, no player notice mentions it, and `cw.signals.counts` is documented "never
  send to a player", like `cw.history`.

## 10. Tests that pin it

Test-first and broad, targeted runs only. Fake clock throughout (`Clock`, no `Date.now()`).

**Pacing core (`packages/core/test/pace.test.ts`, `pace-chat.test.ts`, `policy-layer-pace.test.ts`)**
- `resolvePace`: all unset gives all null; each field's min and max accepted, one below and one above refused with the right path
  (`pace.burst.lines`, `pace.slowModeMs`, ...); a fraction, `NaN`, `Infinity`, a string and a negative are refused; the message never echoes the value.
- `mergePace`: absent inherits, `null` turns off, a value sets; a room override of `{}` changes nothing.
- Off by default: with no `pace` the chat results for a script of lines equal the 0.1.6 results (golden).
- `slow_mode`: refused inside the gap with the exact `retryAfterMs`; accepted at exactly the gap; a refused line does not move `lastAt`;
  another player in the same room is unaffected; the same player in another room is unaffected; a guest is keyed by seat.
- `flood`: the (N+1)th line in the window is refused with `retryAfterMs = oldest + window - now`; a line after the oldest ages out is
  accepted; N lines spread over more than the window never trip; a refused line is not counted toward the next window.
- `duplicate`: same text refused; case, spacing, punctuation and accent-free full-width variants refused as the same; a different line
  accepted; lines under the minimum normalized length never refused; a refused duplicate does not extend its own block; the third
  distinct line after two duplicates is fine; the window edge is exact (just inside refused, at the edge accepted).
- Order: a line that would be both `slow_mode` and `flood` is `slow_mode`; both `flood` and `duplicate` is `flood`; pacing runs after
  `restricted` and `length` and before `rate`; a `rate`-refused line commits nothing; a matcher-blocked line commits (spends its slot).
- Cost: with a counting matcher, a line refused for pacing never reaches `match`, `spans` or the profanity filter, and writes no
  evidence, strike or notice.
- `retryAfterMs` is at least 1 and a whole number; no refusal contains text, an id or a `rule`/`noticeId`.
- Room overrides: `setPace` applies at once; `null` removes; `{ slowModeMs: null }` disables only that check; `rooms.close` drops it; an
  invalid override throws `ProfileError`; the override beats the stored layer, which beats the code profile.
- Memory: 100 000 distinct players over time leave the map within its cap; sweeping drops quiet keys; `rooms.close` drops a room's keys.
- Live settings: a saved layer applies to the next line with no restart; a stale key does not apply a longer window than the current one.
- Layer: `pace` is an editable section; a layer touching `pace.nope` is refused with its path; reset restores the base; `changedSections`
  lists it; an audit row has `sections: ['pace']` and no values.

**Flood signal (`pace-signal.test.ts`)**
- A flood trip records `flood_triggered` once per window per player per room, deferred (the verdict is returned before the write);
  five trips in one window leave one row; a second window leaves a second (subject to the per-room-per-day cap); `slow_mode` and
  `duplicate` record nothing; a guest records nothing; a store failure is absorbed and logged by class only; a store without signals is
  skipped and logged once.

**Signals core (`signals.test.ts`, `signals-guards.test.ts`, `signals-counts.test.ts`, `signals-feeds.test.ts`)**
- Declaration: a bad slug, a label of 0 or 61 characters or with markup, a polarity outside the two, a weight outside 0 to 10, more than
  40 kinds are refused with paths; re-declaring `flood_triggered` may relabel but not make it positive.
- `record`: declared kind true; undeclared false; malformed input (non-string kind, missing subject, `roomId` with a space, `at` in the
  far future or before retention) false; never throws for any input, including hostile objects; subject equal to `by` false (also when
  they differ only by a merge); an unknown `RawWho` false and creates no subject.
- The cap: a second record of the same (kind, subject, by) inside the window is false, after the window true; different kind, subject or
  by is unaffected; two concurrent processes on one database write one row (contract).
- Counting: ten rows from one `by` count 1; five different `by` count 5; source-less rows count per room, and per day without a room;
  merged aliases fold (two aliases of one `by` count once); weights per source take the max; weight 0 drops a source; `minWeight` is
  honoured; the window edge is exact; a kind outside the request is absent.
- New-account guard: no hook means no weighting even when the profile sets `newAccount`; with a hook, an age below `belowDays`
  multiplies the stored weight, at or above does not, `null`/throw means unknown (factor 1); changing the guard does not rewrite stored rows.
- Feeds: `record` lists only chosen kinds and window; `queue` and `ladder` refuse a positive kind with `raise`/boost; an unknown kind in
  a feed is refused; windows above retention or above 90 days are refused.

**Ladder (`ladder-signals.test.ts`)**
- With no feed the suggestion is deep-equal to 0.1.6's for the golden table. `note` appends the sentence and leaves the outcome. `raise`
  moves one step in the same column and never beyond step 5, never into a permanent cell (falls back to the note), never below the
  first-offence outcome, and is a no-op for `banter`. Two rules firing combine to at most one step. The area-rule swap still applies
  after a raise. Positive-only hits only ever note.

**Queue (`team-signal-boost.test.ts`, `admin.signals.test.ts`)**
- Take-next without the filter is unchanged. With it: a boosted newer case is claimed before an ordinary older one; an overdue ordinary
  case is claimed before a newer boosted one; among boosted, oldest first; a boosted case held by someone is skipped; the scan cap
  falls back to the oldest free case; it composes with `rankDownHabitual` (boosted is not ranked down); nothing is ever dropped from the
  queue. `GET /reports` carries `boosted` only with the feed on.

**Store (`test/contract/signals.contract.ts`, run by both stores; `store-sqlite/test/migrations` for 21)**
- Insert/cap/list/purge semantics, strict purge edge, empty list, aliases, bounded grouped result; migration 21 from a version-20
  database, from an empty database, and rerun refusal; the `ALTER` leaves existing `kit_ai_reads` rows readable.

**Retention (`retention.test.ts` additions)**
- Default 90 days; floor 14 days refused below; non-finite refused; `purge` reports `signals`; a feed window above `signalsMs` refused.

**AI input (in the 0.1.6 AI test folder)**
- With `feeds.ai` off the rendered prompt and hash equal 0.1.6's; on, the block holds label, polarity, distinct and window and nothing
  else (a test that scans the rendered text for a subject id, a room, a time and a kind id); the hash is the same before and after a
  new signal arrives; "Read again" takes a new snapshot; `signals_json` records exactly what was sent.

**HTTP and hub**
- Bodies byte-identical with everything off (snapshot of `GET /reports`, `GET /reports/:id`, `GET /people/:ref/history`, `POST /cases/next`).
- `PUT /policy/profile` with `pace`: 200, 409 on a stale version, 400 with the layer path; a `signals` layer naming a kind is 400.
- `hub-react`: the Advanced section appears for `policy.read` only; the pace form validates and saves with a reason; suggested values
  fill but do not save; a conflict offers a reload; Simple's menu is unchanged (snapshot); the Person page shows signal lines only with the
  feed on and counts above 0, and no element outside the Timeline panel; the public API snapshot (`api.test.ts`, `apiNames.ts`) is
  updated deliberately; no new always-visible element (a DOM snapshot of the queue, case card and top bar is unchanged).
- `player-react`: `RestrictedChatLine` with `pace` renders each reason with seconds, no referee card, `role="status"`; the old props
  render exactly as before; `retryAfterMs` of 500 reads "1 second"; 119 000 reads seconds, 125 000 defers to minutes; `no-leak.test.tsx`
  passes; `size.test.ts` budget holds.

## 11. Risks

- **Pacing is per process.** Stated in 4.6. A multi-process game with no room affinity gets a looser limit. Mitigation: the advice, and
  the fact that nothing is written either way.
- **A type widening in a patch release.** `RefuseReason` gains three members and the `refuse` arm an optional field. An adopter with an
  exhaustive `switch (reason)` that ends in `assertNever` will fail to compile after upgrading, though it can only ever receive the new
  reasons after turning pacing on. The changeset says so in its first line. The alternative (a new result arm) breaks more code.
- **Colluding accounts.** Distinct-source counting does not stop a group of real accounts. Mitigations are structural, not
  statistical: signals never act, the boost is capped and expires at 24 hours of waiting, `raise` is one step and never permanent, and
  the Person line shows the time spread.
- **A noisy game.** A game that records a signal on every event pays one small write each. The cap bounds rows, not calls. The README
  says "events, not lines".
- **Weights as a lever.** A weight of 10 on a kind makes one source count as ten toward `minWeight`. It is the adopter's own code and
  stays code-only; the hub cannot set it.
- **The AI note's data-minimisation list changes.** One sentence there is amended (5.7). It is opt-in per feed and recorded per read.
- **Normalization is not language-aware.** The duplicate check keys on letters and digits after NFKC; scripts without case, or lines
  that differ by one word, are not duplicates. That is the point (it is a repeat detector, not a similarity filter).

## 12. Not in this release

- An incoming-webhook action `signal` for games that are not Node (`POST /webhooks/in/action`); in-process `record` first.
- A signal that lowers a suggestion, or any effect from a positive kind other than a note or the record.
- A hub view of "who currently meets a rule", a signal preview in the ladder preview, or a moderator-side discard of a signal.
- Per-room settings stored in the kit (a room override lives in the game's process).
- Shared pacing state across processes; a store-backed limiter.
- A fan-out guard (one `by` signalling many subjects in a short time).
- Signals in webhooks, the Discord feed, or any player-facing surface.
- A locale other than English for the new words (the keys are flat, so translations are additive).
- Site copy. The public site flips a promise only after the release is on npm and has run in Moxgate, as for the AI levels.

## 13. Rollout and docs

- One changeset, patch, in the fixed group (0.1.7); the first line says "adds a refusal reason". Peer floors raised by hand as the
  earlier releases did.
- `@experimental` on: `PaceSettings`, `ResolvedPace`, `resolvePace`, `mergePace`, `PACE_SUGGESTIONS`, `rooms.setPace`, `rooms.pace`,
  `cw.signals.*`, every signal type, `signalBoost`, the `pace` prop of `RestrictedChatLine`, `secondsLeft`. Listed in the READMEs until 0.2.
- Docs: core README (`cw.signals`, `cw.rooms.setPace`, retention table, the refusal reasons), http README (the changed bodies),
  player-react README (the `pace` prop and words), hub-react README (Settings, Advanced).
- Tests that lock exports are updated deliberately: hub-react `api.test.ts` and `apiNames.ts`, player-react `static.test.ts`.

## 14. Open questions

Each has a recommendation; the controller rules.

1. **Where the refusal lives.** New reasons on `RefuseReason` plus `retryAfterMs` (this note), or a third `ChatResult` arm. *Recommended:
   reasons on `refuse`:* it widens a union instead of changing every adopter's narrowing.
2. **Signals recorded without being configured.** Record the built-in `flood_triggered` whenever pacing's `burst` trips, even if the
   adopter never declared a signal or a feed. *Recommended: yes,* it is cheap, bounded, kept 90 days, and gives a new adopter history
   the day they turn a rule on.
3. **Queue boost cap and expiry.** A fixed 0.5 in the hub's score, claimed ahead only until a case has waited 24 hours, scan of 200
   people. *Recommended: as written;* all three are constants, easy to change later.
4. **`signals.retention` default.** 90 days, floor 14. *Recommended: 90 / 14.* Feeds longer than retention are refused.
5. **Accepting `RawWho` as well as a subject id in `record`.** *Recommended: both,* so a game that only knows its own account ids can
   record without a lookup of its own; a stranger is refused rather than created.
6. **Suggested pace values.** The table in 4.1. *Recommended: ship them as suggestions only,* never as defaults, since a default would
   change existing installs.

## 15. Rulings

*(To be filled by the controller when the questions above are answered.)*

## Rulings (2026-11-12, controller, under the owner's "continue autonomous until you finish the entire chatwarden roadmap")
All six open questions take the recommendation:
1. Pacing refusals are new `RefuseReason` values (`slow_mode`, `flood`, `duplicate`) with an optional `retryAfterMs`; no third `ChatResult` arm.
2. `flood_triggered` is recorded whenever the burst check trips, declared signals or not (bounded, 90-day retention).
3. Queue boost constants as written (0.5 in the hub score; ahead of older cases only until a case has waited 24 hours; scan of 200).
4. Signals retention 90 days by default, 14-day floor; a feed window longer than retention is refused.
5. `signals.record` accepts a subject id or a `RawWho`; an unknown identity is refused, never created.
6. The suggested pace values are offered behind a hub button, never applied as defaults.
Sequencing: this release follows 0.1.6 (AI levels 1-2) and takes SQLite migration 21. If the AI release slips, the one ALTER on an AI table moves as the doc says.

### Plan-time rulings (2026-11-12, from writing docs/plans/2026-11-12-flood-control-and-signals.md)
All accepted as the plan states them:
1. `secondsLeft` uses `Intl.RelativeTimeFormat` like `timeLeft`; the three pace messages drop the literal "in"; no `player.pace.wait.*` keys.
2. With `feeds.ai` off the variable prompt part is byte-identical to 0.1.6 and the stable part is identical whether the feed is on or off; the hash differs from 0.1.6 only through `promptVersion` 2.
3. `inputHash` is computed over the variable text rendered without the signal block.
4. `cw.signals.boosted(people)` and `cw.signals.forRecord(subject)` are added, `@experimental`; the ladder reads signals through facade-internal glue in `cw.suggest`.
5. At load, `pruneSignalFeeds` drops only a feed that has become unusable and logs `chatwarden.signal_feed_dropped` (no ids); save-time validation stays strict.
6. A layer's `feeds` replaces the base's wholesale.
7. The pacer's `check` is timing-pure; its only write is the `floodSignalAt` bookkeeping when it returns `signalFlood: true`.
8. `signals.record` refuses a subject-id string the subject index has never seen (`unknown_subject`).
9. No audit action is added; a test pins `AUDIT_ACTIONS` unchanged.
10-11. The plan rebases on main after 0.1.5 (merged, fbbaebc) and 0.1.6; Tasks 7, 12, 14 and 16 wait for 0.1.6.
12. Peer floors: store-memory, store-sqlite and http on core `^0.1.7`; hub-react on core and http `^0.1.7`; player-react only if it imports a new core name; hub-element by `peerRangeOf`.
13. The hub first-load budget is the number in `packages/hub-react/test/size.test.ts` on main at build time (76,800 B as of 0.1.5); fix a stale header comment if found.
