---
status: draft, awaiting controller rulings (section 11)
updated: 2026-11-12
release: 0.1.8
---

# Appeals inbox and offensive names

Two features from the owner's roadmap (`docs/design/2026-11-10-editable-ladder-and-roadmap.md`, Part 2, which is binding intent).
**Part A, appeals:** "Think this is a mistake?" becomes, when the adopter turns it on, a player route that files an appeal against one
sanction, an inbox in the hub, and a decision (uphold, reduce, revoke) that tells the player and feeds back into the AI's casebook.
**Part B, names:** the kit already answers "may a player use this name?"; this note adds a second check, a way for a moderator to
require a rename, and the rules that keep names from showing raw in the hub.

This note is written against the code as it stands after 0.1.7 (flood control and signals, `2026-11-12-flood-control-and-signals.md`),
which came after 0.1.6 (AI levels 1 and 2) and 0.1.5 (triage speed). Store migrations therefore start at **22**: 19 is the
reporter-outcome index (0.1.5), 20 the AI reads and casebook (0.1.6), 21 signals (0.1.7). The AI note's `markReversed` seam and its
`kit_ai_outcomes` table are cited from its branch; they are not on `main` yet.

## 1. Why

**Appeals.** Today the player's notice carries a link, "Think this is a mistake?" (`AppealLink` in `packages/player-react/src/ui.tsx`,
fed by the adopter's `appealUrl` prop on `NoticeQueue` and `MyRecord`). It leaves the kit: the adopter builds a form, a mailbox or a
Discord thread, and what comes back is a message nobody can tie to a sanction, rate-limit, route to a different moderator or learn from.
A moderation tool that cannot say how often it was wrong cannot improve. The owner (2026-11-10): "granted appeals should flow back into
the decision engine that makes the ai call so it reduces further false positives." An appeal is the cleanest wrong-answer signal the
kit will ever get: a person who was acted on, a second moderator who looked again, a recorded result.

**Names.** A name is chat that stays. `cw.names.check(text)` (`chatwarden.ts`, behind `POST /names/check` in `packages/http/src/player.ts`)
already reads a name through the matcher's name rules (`matchName` in `packages/matcher/src/names.ts`: `Zorbak_99` is caught, not only
`zorbak`) and answers `{ ok: true }` or `{ ok: false, reason: 'name_not_allowed', rule }`. What is missing is everything around it: an
optional profanity check, a way for a moderator to say "choose a new name" to a player who already has one, a way for the game to be
told, evidence when someone tried a blocked name, and not showing the name raw to the moderators who read it.

## 2. Goals and non-goals

### Goals
- An opt-in, in-kit appeal: filed by a player against one sanction with one capped statement, rate limited, decided by a moderator who
  did not make the original decision, answered through the player's existing notices.
- A granted appeal (reduce or revoke) marks the original decision reversed in the AI casebook, adds a corrective example, and counts
  toward a per-rule false-positive rate that the hub shows behind the advanced door and the AI read is given.
- An appeal event in the event list, webhooks and the Discord feed, like the report events.
- Name checks that stay stateless unless the adopter opts in to keeping blocked names as evidence.
- A moderator can require a rename from the Person page; the player gets a notice of a new kind; the game is told.
- Names shown in the hub masked like blocked chat lines.
- Store migration 22 in the memory and SQLite stores, with parity covered by contract suites.

### Non-goals
- Appeals by reporters ("you dismissed my report"), appeals against a report decision that made no sanction, and appeals of a `note`
  (a note makes no notice, so there is nothing for the player to appeal from).
- A free-text reply from the moderator to the player. The outcome notice is fixed words.
- The kit owning names. It never stores a player's current name, never renames anyone, and never learns the new one. The game renames.
- Any change to what the term matcher blocks or to the AI ceilings.
- The AI reading an appeal statement. A statement is never sent to a provider.

## 3. Rulings (decided; the details below follow from them)

1. **Ruling: Appeals are off until the adopter turns them on**, in code (`profile.appeals.enabled`) or in the hub. With them off, every route
   answers as if it did not exist, the notices show the old `appealUrl` link if there is one, and no response body changes.
2. **Ruling: An appeal is filed from a sanction notice, one per sanction for the sanction's lifetime.** The player holds a notice id, not a
   sanction id. Warnings, chat restrictions, public-room bans and full bans are appealable while they are in the player's record; a
   report outcome, a note and the new message kinds are not. A reduced sanction is a new sanction and can be appealed once.
3. **Ruling: The statement is player text, capped at 1000 characters, refused rather than cut when over.** It is stored like a report note
   (plain text in the appeal row), masked in the hub like a blocked chat line, purged by retention, and never put in an event, a
   webhook, a Discord post, a log or an AI prompt.
4. **Ruling: Appeals live inside the existing Cases queue as a view, not as a second tab.** Reason in 4.9.
5. **Ruling: A decision is uphold, reduce or revoke**, reason required (private, like a sanction's), and the player is told through a new
   notice kind, one per outcome.
6. **Ruling: The moderator who made the original decision cannot decide the appeal**, enforced in the core (`same_decider`), with a
   deliberate per-kit switch, `allowSelfReview`, for a one-person team. Automatic sanctions have no human decider and are open to anyone
   with the permission.
7. **Ruling: Deciding an appeal takes the new permission `appeals.decide`, default `senior`**, and reading needs `appeals.read`, default
   `moderator`. Adopters lower either through the existing `permissions` option, as `terms.write` is.
8. **Ruling: A granted appeal means reduce or revoke.** It marks the original decision reversed (kept out of the casebook as a positive
   example), adds a corrective example for that rule and conduct level, and counts toward the per-rule false-positive rate.
9. **Ruling: `cw.names.check` stays synchronous, stateless and free of text in its answer.** It gains an optional profanity pass and an
   optional `who` so a blocked name can be kept as evidence; it stores nothing unless the name is blocked and the adopter opted in.
10. **Ruling: A required rename is a notice and an event, nothing more.** The notice tells the player to choose a new name. The game hears
    through `cw.on('rename.required')` or a webhook and renames. The kit offers `pendingRename` and `renamed` so a game can hold a
    player at a rename screen and release them.
11. **Ruling: Names are masked in the hub when the matcher flags them**, on a setting that defaults on (the only display-only change
    in this release that touches an existing install; question 4).

## 4. Part A: appeals

### 4.1 Settings

A new optional profile field, `appeals`, in code and as an editable layer section (appended to `POLICY_SECTIONS` as `'appeals'`).

```ts
// packages/core/src/appeals.ts (new)

/** The longest statement, in characters. A constant, not a setting: it bounds what is stored. */
export const APPEAL_STATEMENT_MAX = 1000;

/** @experimental */
export interface AppealSettings {
  /** Default false. */
  enabled?: boolean;
  /** Appeals one player may file in any rolling 7 days. 1 to 20, default 3. */
  perPlayerPerWeek?: number;
  /** May the moderator who made the original decision decide the appeal? Default false. For a team of one. */
  allowSelfReview?: boolean;
}
/** @experimental */
export interface ResolvedAppeals { enabled: boolean; perPlayerPerWeek: number; allowSelfReview: boolean }
```

`profile.ts`: `TOP_KEYS` gains `appeals`; `ModerationProfile.appeals?: AppealSettings`; `ResolvedProfile.appeals: ResolvedAppeals`;
`PolicyLayer.appeals?: AppealSettings`. The presets ship it unset, so nothing changes for an existing install.

### 4.2 Filing (the player side)

```ts
/** What a player sees of an appeal. No staff field, no reason, no id of a sanction or a person. @experimental */
export interface PlayerAppeal {
  id: string;
  /** The notice it was filed from. */
  noticeId: string;
  status: 'open' | 'upheld' | 'reduced' | 'revoked';
  createdAt: number;
  decidedAt: number | null;
}

export type AppealRefusal =
  | 'off'                 // appeals are not enabled
  | 'not_found'           // not the caller's notice, or no such notice (the same answer, so ids cannot be probed)
  | 'not_appealable'      // the caller's notice, but not a sanction in their record
  | 'statement_invalid'   // empty after trimming, or over APPEAL_STATEMENT_MAX characters
  | 'already_appealed'    // this sanction has had its appeal
  | 'rate';               // perPlayerPerWeek reached

export type AppealFileResult =
  | { ok: true; appeal: PlayerAppeal }
  | { ok: false; refused: AppealRefusal; retryAfterMs?: number };   // retryAfterMs on 'rate'

// on Chatwarden
appeals: {
  /** Whether appeals are on right now (a live read of the profile). */
  enabled(): boolean;
  /**
   * File an appeal from one of the caller's own sanction notices. Takes the same `RawWho` as `cw.notices` and FINDS the person (never creates).
   * Checks in this order: off, not_found, not_appealable, statement_invalid, already_appealed, rate. One store transaction; a refusal writes nothing.
   * The statement is trimmed, stripped of control, bidirectional and zero-width characters, and has runs of blank lines collapsed; it is
   * refused, not cut, over 1000 characters. Never throws for a bad input; a store failure is logged by class and answers `not_found`.
   * @experimental
   */
  file(who: RawWho, input: { noticeId: string; statement: string }): AppealFileResult;
  /** The caller's own appeals, newest first, at most 50. Empty for an unknown person. */
  mine(who: RawWho): PlayerAppeal[];
  // staff side: section 4.6
};
```

"Appealable" is decided from the notice row alone, with the same rule `NoticeService.record` uses for "My record" (a warning for 90
days; a timed sanction while it runs or within 90 days; a permanent one until withdrawn), restricted to the four sanction kinds. That
reuses an existing definition instead of inventing a window. Counting for `rate` is by the person across merged aliases, in the last 7
days. `retryAfterMs` is the time until the oldest of those leaves the window.

### 4.3 Deciding

```ts
export const APPEAL_OUTCOMES = ['uphold', 'reduce', 'revoke'] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];
export type AppealStatus = 'open' | 'upheld' | 'reduced' | 'revoked' | 'moot';

/** @experimental */
export interface AppealDecision {
  appealId: string;
  outcome: AppealOutcome;
  /** A staff ref the audit trail accepts. */
  actor: string;
  /** Private, 1 to 500 characters. Never shown to the player. */
  reason: string;
  /** `reduce` only: the lighter outcome that replaces the sanction. */
  to?: { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null };
}

export type AppealDecideResult =
  | { ok: true; status: 'upheld' | 'reduced' | 'revoked'; replacementGroupId?: string }
  | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' | 'same_decider' | 'gone' };

// on Chatwarden['appeals']
/**
 * Decide an open appeal. One store transaction, once: a second call answers `already_decided` and writes nothing.
 *   uphold  the sanction stands; the player is told.
 *   revoke  the sanction group is revoked (its notice withdrawn) and the original decision is marked reversed.
 *   reduce  `to` must be lighter than the original (a lower kind, or the same kind and a shorter length; permanent is longest). The group is
 *           revoked and a replacement is written with the ORIGINAL start time and the same rule and room, so the ladder's 90-day lookback
 *           does not restart; the player gets the replacement's own notice as well as the outcome notice.
 * `same_decider`: `actor` made the original (human) decision and `allowSelfReview` is off. `gone`: the sanction was revoked before.
 * `invalid`: a bad outcome, a `to` that is not lighter, a missing reason, or `to` given for another outcome.
 * @experimental
 */
decide(input: AppealDecision): Promise<AppealDecideResult>;
```

Why the replacement keeps the original start: the ladder reads sanctions by start time, so a "reduced to a warning" written at the moment
of the appeal would look like a brand new warning and push the person's 90-day window forward. Keeping the start makes a reduction a
reduction in the record, not just in the length. This needs one internal addition to `SanctionInput`, `startsAt?: number` (marked
`@internal`, accepted only from the appeals service), and the replacement is a subject row like any other.

The transaction (all or nothing, built on the same pieces `DecisionService` uses: `revokeSanction` and `writeSanction` in
`sanctions.ts`, `NoticeService.createForSanction` and `withdrawGroup` in `notices.ts`):

1. Conditionally move the appeal from `open` (zero rows changed means `already_decided`).
2. Check independence (4.5) and, for `reduce`, that `to` is lighter.
3. Revoke the group, write the replacement, create its notice (reduce); or revoke (revoke); or nothing (uphold).
4. Create the outcome notice: kind `appeal_upheld`, `appeal_reduced` or `appeal_revoked`, carrying the original rule and reference code.
5. For reduce and revoke, call the AI seam (4.4) when the AI is present.

After the commit: announce the player's pending notices (`NoticeService.announce`), update the in-memory sanction index, and emit
`appeal.decided` (4.11). Each is fenced and cannot fail the decision.

If a sanction with an open appeal is revoked by anyone else (the Person page's Revoke, or `cw.sanctions.revoke`), the open appeal
becomes `moot` in the same transaction, with no outcome notice (the revoke already withdrew the player's notice) and no count toward
granted appeals: nobody ruled on it.

### 4.4 What a granted appeal feeds

A granted appeal (status `reduced` or `revoked`) does three things for the AI of 0.1.6. All three are no-ops when the kit has no AI.

1. **Marks the original decision reversed.** The appeal row remembers `report_id`, the report whose decision made the sanction (4.7).
   The service calls the AI note's `cw.ai` seam, `markReversed(reportId)`, which sets `kit_ai_outcomes.reversed`; the existing example
   query ("same rule and same severity ... not reversed") then keeps that decision out of the examples, and the AI note's stats count it
   as an AI false positive when the AI had recommended acting.
2. **Adds a corrective example.** `markReversed` gains an optional second argument, `{ corrective: true }`, and `kit_ai_outcomes` a
   column `corrective INTEGER NOT NULL DEFAULT 0` (migration 22). A corrective outcome that still has its pseudonymised `example_json`
   (learning on, inside `aiExamplesMs`) becomes an example of the opposite sign for its rule and the conduct level the moderator had
   settled on. The example query may use at most one of the two example slots for a corrective row; corrective rows are eligible once
   the 30-teachable-rows threshold is met, and do not count toward it. The prompt labels it with fixed words ("a moderator acted on this,
   and a second moderator decided on appeal that it was not a violation"), `AIExample` gains `kind: 'standard' | 'corrective'`, and
   `promptVersion` is bumped. A reversed row with no example text still counts in the rate, but teaches nothing.
3. **Counts toward the per-rule false-positive rate**, given to the AI read as a caution (below) and kept for the level 3 and 4 gates.

The statement is not part of any of this.

**The false-positive rate.** Per rule, over a window (90 days by default):

```ts
export const APPEAL_STATS_MIN_SANCTIONS = 10;   // below this a rule has no rate
export const APPEAL_RATE_ELEVATED = 0.15;
export const APPEAL_RATE_HIGH = 0.30;

/** @experimental */
export interface AppealRuleStats {
  rule: number | 'uncovered';
  /** Sanctions given under the rule in the window (warning, chat, area, ban; notes are not counted). */
  sanctions: number;
  appealed: number;
  /** Reduced or revoked on appeal. */
  granted: number;
  /** granted / sanctions, or null below APPEAL_STATS_MIN_SANCTIONS sanctions. */
  rate: number | null;
  band: 'normal' | 'elevated' | 'high' | null;
}
/** @experimental */
export interface AppealStats {
  windowDays: number;
  perRule: AppealRuleStats[];                 // by rule number, 'uncovered' last
  overall: { sanctions: number; appealed: number; granted: number; rate: number | null };
}
// on Chatwarden['appeals']
stats(q?: { days?: 30 | 90 | 365 }): AppealStats;   // staff only
```

The denominator is every sanction given under the rule, not only the appealed ones, because most people never appeal; the rate is "how
often a decision under this rule was found wrong when someone asked". `GET /appeals/stats` and the AI feed use the 90 day window.

**Given to the AI read.** `AIReadInput` gains, in the variable part and outside the invalidation hash (the rate moves slowly but a
new appeal should never re-read the open queue; "Read again" takes a fresh copy):

```ts
cautions?: Array<{ rule: number; band: 'elevated' | 'high' }>;   // only rules at those bands; never a number, never a person
```

The stable prefix gains one paragraph, always present: for a rule listed as cautioned, decisions under it were often reversed on
appeal, so prefer lower confidence or `unclear` unless a line makes the violation plain. The model gets a band, not the rate, in the same
spirit as the AI note's choice of confidence words over numbers. The levels 3 and 4 gates will read `stats()` directly; this note
builds no gate.

### 4.5 Who may decide, and how independence is kept

- **Permissions** (appended to `PERMISSION_KEYS` and `PERMISSIONS` in `packages/http/src/permissions.ts`; mirrored in hub-react's
  `PermissionKey`): `appeals.read` is `moderator` (a moderator can see the inbox and the numbers); `appeals.decide` is `senior`.
  A one- or two-person shop whose people are all `moderator` lowers it with `permissions: { 'appeals.decide': 'moderator' }`, the same way
  they would lower `terms.write` or raise `policy.write`.
- **Enforcement.** The core refuses `same_decider` when `AppealDecision.actor` equals the `actor` stored on the sanction group's subject
  row (`SanctionRow.actor`, already kept) and the row is not automated. This is enforced where the decision is made, not in the UI,
  so a webhook or a script cannot bypass it. It compares staff refs: a team that shares one login is a team of one to the kit, which is
  why the README advises one login per person.
- **The one-person team.** `appeals.allowSelfReview` (off by default; owner edit in Settings, Advanced, audited as `policy.update`) lifts
  the refusal for the whole kit. There is no per-actor exemption and no "owner may" shortcut: a larger team that loosens it did so on
  the record.
- **Decisions made by a webhook** carry the webhook's configured `actor`; a human deciding the appeal is a different actor, so the rule
  holds.
- **Advice, not enforcement:** the hub shows who gave the original decision on the appeal card in Detailed mode, so a moderator can see
  at a glance why a decision is refused to them.

### 4.6 API summary (staff side)

```ts
export interface AppealSummary {
  id: string;
  createdAt: number;
  status: AppealStatus;
  person: SubjectId;          // a staff ref
  /** The sanction. */
  sanction: { groupId: string; refCode: string; kind: SanctionKind; rule: RuleRef | null; startsAt: number; endsAt: number | null; decidedBy: string; automated: boolean };
  /** Whether the statement trips the term filter, so the hub can mask it. The text is not in a list. */
  statementFlagged: boolean;
}
export interface AppealDetail extends AppealSummary {
  /** The player's words. Staff only. Null once purged. Masked by the hub when `statementFlagged`. */
  statement: string | null;
  /** Who decided, when, and why (private), once decided. */
  decided: { by: string; at: number; reason: string; replacementGroupId: string | null } | null;
  /** The report whose decision made the sanction, when known. */
  reportId: string | null;
  /** What the player was shown with the sanction: their own lines, as the notice kept them (already masked where blocked). */
  shown: Array<{ text: string; day: string }>;
}
export interface AppealPage { items: AppealSummary[]; next: string | null }

// on Chatwarden['appeals']
list(q: { status?: 'open' | 'decided' | 'all'; limit?: number; cursor?: string | null }): AppealPage;   // default open, oldest first; limit 1..200
get(id: string): AppealDetail | null;
decide(input: AppealDecision): Promise<AppealDecideResult>;
stats(q?: { days?: 30 | 90 | 365 }): AppealStats;
openCount(): number;
```

`statementFlagged` is `matcher.match(statement) !== null`, computed when read, so a term added tomorrow masks yesterday's statement. A
matcher that throws reads as not flagged (logged by class), the same fail-open the chat path uses.

### 4.7 Store and migration 22

New optional `Store` methods, synchronous like claims and notices; memory and SQLite; one shared contract suite
(`test/contract/appeals.contract.ts`). A store without them cannot enable appeals: `createChatwarden` throws a plain message when
`profile.appeals.enabled` is true in code. An owner's stored layer is refused on save (`layer.appeals.enabled`) and, if already stored, leaves appeals off with the warning `chatwarden.appeals_unsupported_store`; `cw.appeals.enabled()` is false otherwise.

```ts
export interface AppealRow {
  id: string; subject: SubjectId; groupId: string; noticeId: string; reportId: string | null;
  rule: string | null; kind: SanctionKind; statement: string | null;
  status: AppealStatus; createdAt: number;
  decidedAt: number | null; decidedBy: string | null; decisionReason: string | null; replacementGroupId: string | null;
}
// on Store (all OPTIONAL)
insertAppeal?(row: AppealRow): boolean;                        // false when an appeal for the group exists (unique on group_id)
loadAppeal?(id: string): AppealRow | null;
listAppeals?(q: { status?: 'open' | 'decided' | 'all'; limit: number; after?: { createdAt: number; id: string } }): AppealRow[];
countAppealsBy?(subjects: readonly SubjectId[], since: number): { count: number; oldestAt: number | null };
countOpenAppeals?(): number;
decideAppeal?(id: string, patch: { status: 'upheld' | 'reduced' | 'revoked'; at: number; by: string; reason: string; replacementGroupId: string | null }): boolean; // only from 'open'
closeAppealsForGroup?(groupId: string, by: string, at: number): number;                  // open -> moot
appealCountsByRule?(since: number): Array<{ rule: string | null; appealed: number; granted: number }>;
countSanctionsByRule?(since: number): Array<{ rule: string | null; count: number }>;     // warning, chat, area, ban; subject rows
loadSanctionSubjectRow?(groupId: string): SanctionRow | null;                            // kind, actor, source, start, end
clearAppealStatements?(before: number): number;                                           // statement -> NULL where decided_at < before
purgeAppeals?(before: number): number;                                                    // decided rows with decided_at < before
// names (Part B)
insertBlockedName?(row: BlockedNameRow): void;
listBlockedNames?(since: number, limit: number): BlockedNameRow[];
purgeBlockedNames?(before: number): number;
```

SQLite **migration 22** (append only; one savepoint with the version bump):

```sql
-- Appeals: one row per appeal, one appeal per sanction group for its lifetime.
CREATE TABLE kit_appeals (
  id                   TEXT PRIMARY KEY,
  subject_id           TEXT NOT NULL,
  group_id             TEXT NOT NULL,
  notice_id            TEXT NOT NULL,
  report_id            TEXT,
  rule                 TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('warning', 'chat', 'area', 'ban')),
  statement            TEXT,
  status               TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'reduced', 'revoked', 'moot')),
  created_at           INTEGER NOT NULL,
  decided_at           INTEGER,
  decided_by           TEXT,
  decision_reason      TEXT,
  replacement_group_id TEXT
);
CREATE UNIQUE INDEX kit_appeals_by_group   ON kit_appeals (group_id);
CREATE INDEX        kit_appeals_by_subject ON kit_appeals (subject_id, created_at);
CREATE INDEX        kit_appeals_by_status  ON kit_appeals (status, created_at, id);
CREATE INDEX        kit_appeals_by_rule    ON kit_appeals (rule, created_at);

-- The report whose decision made a sanction, so a granted appeal can mark that decision reversed. Set by `decide` from 0.1.8.
ALTER TABLE kit_sanctions ADD COLUMN report_id TEXT;
UPDATE kit_sanctions SET report_id = (
  SELECT d.report_id FROM kit_decisions d WHERE instr(d.result_json, kit_sanctions.group_id) > 0 LIMIT 1
) WHERE target_type = 'subject' AND source = 'moderator' AND report_id IS NULL;

-- Notices: four new kinds. SQLite cannot widen a CHECK in place, so the table is rebuilt (as migrations 7 and 11 did kit_sanctions).
CREATE TABLE kit_notices_v22 (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  group_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('warning', 'chat', 'area', 'ban', 'report_outcome',
                                             'rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked')),
  rule         TEXT,
  until        INTEGER,
  ref_code     TEXT,
  excerpt_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  acked_at     INTEGER,
  withdrawn_at INTEGER
);
INSERT INTO kit_notices_v22 SELECT id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at FROM kit_notices ORDER BY rowid;
DROP TABLE kit_notices;
ALTER TABLE kit_notices_v22 RENAME TO kit_notices;
CREATE INDEX kit_notices_by_subject ON kit_notices (subject_id, acked_at, withdrawn_at);
CREATE INDEX kit_notices_by_group   ON kit_notices (group_id);
CREATE INDEX kit_notices_by_created ON kit_notices (created_at);

-- Blocked names kept as evidence (only when the adopter opts in).
CREATE TABLE kit_blocked_names (
  id         TEXT PRIMARY KEY,
  subject_id TEXT,
  name       TEXT NOT NULL,
  term_id    TEXT,
  reason     TEXT NOT NULL CHECK (reason IN ('name_not_allowed', 'name_profane')),
  at         INTEGER NOT NULL
);
CREATE INDEX kit_blocked_names_by_at ON kit_blocked_names (at);

-- The AI casebook's corrective flag (needs migration 20).
ALTER TABLE kit_ai_outcomes ADD COLUMN corrective INTEGER NOT NULL DEFAULT 0;
```

Notes on the migration, in the style of migrations 7, 11 and 17:
- The backfill matches a group id inside `kit_decisions.result_json`. Group ids are random and long, so a false match is not a concern, and
  at kit scale one `UPDATE` over the sanctions is the same trade migration 17 made. Rows it cannot link keep `report_id` NULL: an appeal
  against them still works and still counts in the rate, and simply cannot mark a casebook row.
- It is **one-way**: the notices table is rebuilt, so a database that has run 22 cannot be opened by 0.1.7. The release notes say so, as
  0.1.5's did for migration 19.
- The `kit_ai_outcomes` line is the one coupling to 0.1.6, as in migration 21. If release order changes it moves.
- The memory store keeps the same shapes in maps; the contract suites cover the unique group, `moot`, the conditional decide, the
  counts by rule, the purges and the strict edges.

`NoticeKind` becomes `'warning' | 'chat' | 'area' | 'ban' | 'report_outcome' | 'rename_required' | 'appeal_upheld' | 'appeal_reduced' |
'appeal_revoked'`. Consequences in code: `SANCTION_NOTICE_KINDS` is unchanged (the four new kinds are messages, not sanctions);
`NoticeService.record` keeps only sanction kinds (today it drops only `report_outcome`); `purgeNotices` removes a seen message-kind
notice after `noticesMs` like a seen report outcome, and keeps an unseen `rename_required` until it is seen or withdrawn;
`mustAcknowledge` is false for all four. The player-react `titleKey`/`bodyKey` tables gain them, and an older player-react that does
not know them falls back to "A message from the moderators" instead of failing.

### 4.8 HTTP routes

**Player routes** (`playerRoutes`, `packages/http/src/player.ts`; identity from `identify`, the same limiter style as `/names/check`):

| Route | Answer |
| --- | --- |
| `GET /appeals` | `{ appeals: PlayerAppeal[] }`. Empty for an unknown or IP-only identity. 404 `not_found` when appeals are off. |
| `POST /appeals { noticeId, statement }` | 200 `{ appeal }`. 400 `invalid_statement`; 404 `not_found` (off, not yours, not appealable: one answer); 409 `already_appealed`; 429 `rate_limited` with `retry-after` in seconds (the weekly cap) |
| `POST /names/check { name }` | as today, now passing `who` and returning the new reason |

`POST /appeals` has its own request limiter, `appealsRateLimit` (option, default 10 per hour per identity, salted hash of the identity,
the `Limiter` class already in the file) so a script cannot hammer the core's checks. Malformed requests count.

**Staff routes** (`adminRoutes`, a new `appealRoutes(ctx)` file `packages/http/src/admin/appeals.ts`, registered in `index.ts`; static
paths registered before `/appeals/:id`):

| Route | Permission | Audit | Notes |
| --- | --- | --- | --- |
| `GET /appeals?status=open\|decided\|all&cursor&limit` | `appeals.read` | `appeal.view`, no target, required | `{ items: AppealSummary[], next }`; handles come from `latestHandle`; 400 `invalid_query` |
| `GET /appeals/stats?days=30\|90\|365` | `appeals.read` | `appeal.view`, no target | `AppealStats`; 400 on another `days` |
| `GET /appeals/:id` | `appeals.read` | `appeal.view`, target the appeal, required | `{ appeal: AppealDetail }`; 404 |
| `POST /appeals/:id/decide { outcome, reason, to? }` | `appeals.decide` | `appeal.decide`, target the appeal, best-effort after the write | 200 `{ status, replacementGroupId? }`; 409 `already_decided`; 409 `same_decider`; `gone` is 409 `gone`; 400 on `invalid`; reduce also passes `checkDurationsOffered` (the profile's offered lengths) |
| `POST /people/:ref/rename { reason, rule?, takeOver? }` | `sanctions.apply` | `name.rename_required`, target the person, best-effort | 200 `{ ok: true }`; 404 when renames are off; 409 `pending_rename`; claim rules as `POST /sanctions` (`gateCase`) |
| `GET /blocked?source=name` | `blocked.read` | `blocked.view` | the kept blocked names, same item shape with `text` as the name; default `chat` unchanged |

`GET /me` gains `features: { appeals: boolean; renames: boolean }`, present only when either is on, and `GET /changes` gains
`appeals: number` (the open count) only when appeals are on and the caller can read them; with everything off both bodies are what
0.1.7 sends. `PersonHistory` (the `GET /people/:ref/history` body) gains `appeals` (their appeals, as summaries) and `renames`
(`{ at, pending }` per rename required) so the Person page can show them in its timeline; absent when there are none and the features are off.

### 4.9 Hub UI

**Where appeals live: a view of the existing Cases queue.** The two options were a second tab and a filter. A tab means a second place
a team has to remember to look, a second set of keys and a second claim story; the case pane, soft claims and "take next" are all built
for one list of people with something waiting. An appeal is exactly that (a person, with something a moderator must read and decide),
so it sits in the same queue pane behind a view switch in the filter row that already carries category, claim and wait:
**Reports | Appeals (N)**. The switch is rendered only when appeals are enabled and the caller holds `appeals.read`; with appeals off
the queue pane is byte for byte what it is today. Choosing Appeals swaps the list source (`GET /appeals?status=open`); opening a row
shows the appeal card in the same case pane. There is no claim on an appeal (it is decided by one atomic conditional write; two
moderators racing get `already_decided` for the loser), so no claim chrome appears for it.

**Simple mode** keeps one card per case and its menu (Cases, Words, Blocked, More). It gets exactly one new thing, and only when there
is work: a single quiet line at the top of the Cases list, "1 appeal waiting", that opens the Appeals view. It renders only when appeals
are on, the caller can read them, and the open count is above zero; it is the one conditional line the owner's rule allows. The appeal
card itself is the Simple card's sibling (below).

**The appeal card** (`packages/hub-react/src/case/AppealCard.tsx`, with the decision form beside it):

- Header: the referee card for the sanction, "Appeal against <Restrict chat 24 hours>", the rule chip, when it was given, and in
  Detailed who gave it (so a refusal of `same_decider` is understood).
- **The player's statement**, in its own block. If `statementFlagged`, it is masked with the existing Show control (the same
  `reveal` pattern as `Transcript`, per statement and "show all"). The block is plain text, never HTML or markdown.
- **What the player was shown** (`shown`: their own lines from the notice), and in Detailed a link to the original report.
- Their record: one line in Simple, the link to the Person page in Detailed.
- **Decision:** three controls, **Keep the decision**, **Make it lighter...**, **Remove it**, and a required private reason (the same
  length rules and saved-reason chips as the decision bar). "Make it lighter..." opens the picker: kinds below the original, then
  lengths from `profile.durations` below the original's, no custom length unless the profile allows it. It is disabled for a warning
  (nothing is lighter). A refusal comes back with the reason in words and everything typed kept. No Undo hold: an appeal is not decided
  in a hurry, and Remove and Make-lighter are reversible by hand from the Person page.
- Deciding takes the moderator back to the Appeals list.

**Person page** (`screens/Person.tsx`). Inside the existing record, as timeline entries without a referee card: "Appeal: reduced" and
"Asked to choose a new name" with their dates. Nothing above the timeline changes.

**Settings, Advanced** (the section 0.1.7 introduced; one more panel each):
- **Appeals:** on or off, how many a player may file a week, "Allow the moderator who made the decision to decide it" (off), the
  read-only statement limit, and behind a disclosure **"Mistakes by rule"**: the per-rule table from `AppealStats` (sanctions, appealed,
  granted, the band in words: "usually fine", "often reversed", "frequently reversed"). That is the false-positive rate, behind the
  advanced door, never on a queue or a card. Owner edits; seniors and moderators read.
- **Names:** four switches (4.10).

Strings through `t()`: `hub.appeals.*`, `hub.person.appeal.*`, `hub.settings.appeals.*`, `hub.settings.names.*`. No new colour: the
card is the referee card, the statement is plain, the bands are words.

### 4.10 Player UI and words

player-react changes (`NoticeQueue`, `MyRecord`, `ui.tsx`, `client.ts`, a new `AppealDialog.tsx`):

- `PlayerClient` gains `appeals(): Promise<PlayerAppeal[]>` and `fileAppeal(noticeId: string, statement: string): Promise<FileAppealOutcome>`
  where `FileAppealOutcome = { ok: true; appeal: PlayerAppeal } | { ok: false; refused: AppealRefusal; retryAfter?: number }` (mapped
  from the route's status codes). The client keeps only the documented fields of an answer.
- `NoticeQueue` and `MyRecord` gain `appeals?: boolean` (default false). When true, "Think this is a mistake?" is a button that opens
  `AppealDialog` instead of a link, and `appealUrl` is not used. When a sanction already has an appeal, the same place reads
  "Appeal sent <date>" or the outcome in words. With `appeals` false or absent, the old `appealUrl` link behaves exactly as today.
- `AppealDialog` (exported, `@experimental`, built on the existing `Dialog`, `DialogHostProps`, `Portal` and theming) has one field, a
  textarea with a live count against 1000, Send and Cancel, an inline error for each refusal, and focus returned to the button.
  The statement is sent as typed; the server normalizes it.
- New outcome notices render in `NoticeQueue` as plain messages with one button, "Got it" (acknowledge), no referee card, no appeal
  link; `isSanction` stays false for them.

New words (flat `en` catalog; other locales follow, and a missing key falls back to English):

| Key | English |
| --- | --- |
| `player.appeal.title` | Ask for a second look |
| `player.appeal.intro` | Tell us what you think we got wrong. A moderator will read it and decide again. |
| `player.appeal.label` | What should we know? |
| `player.appeal.hint` | Up to {max} characters. Do not include passwords or personal details. |
| `player.appeal.send` / `.cancel` | Send appeal / Cancel |
| `player.appeal.count` | {n} of {max} |
| `player.appeal.sent` | Appeal sent. You will get a message here when it has been decided. |
| `player.appeal.status.open` | Appeal sent {when} |
| `player.appeal.status.upheld` / `.reduced` / `.revoked` | We kept the decision / We made it lighter / We removed it |
| `player.appeal.refused.already_appealed` | This has already been looked at again. |
| `player.appeal.refused.rate` | You have sent as many appeals as are allowed for now. Try again later. |
| `player.appeal.refused.not_found` | This can no longer be appealed. |
| `player.appeal.refused.invalid` | Write a few words, up to {max} characters. |
| `player.appeal.failed` | We could not send your appeal. Try again. |
| `player.notice.title.appeal_upheld` | We looked again and kept the decision |
| `player.notice.body.appeal_upheld` | A moderator read your appeal. The original decision stands. |
| `player.notice.title.appeal_reduced` | We looked again and changed the decision |
| `player.notice.body.appeal_reduced` | A moderator read your appeal and made the decision lighter. The new decision is on your record. |
| `player.notice.title.appeal_revoked` | We looked again and removed the decision |
| `player.notice.body.appeal_revoked` | A moderator read your appeal and took the decision off your record. |

The copy is second person, plain, never shaming, and promises only what is true: it does not say "someone who was not involved" (a
team of one may have set `allowSelfReview`). `size.test.ts` (the player-react bundle budget) is re-checked; the dialog loads lazily if
the budget needs it.

### 4.11 Events, webhooks, Discord

Two events appended to `KitEvent` and `KIT_EVENT_TYPES` in `events.ts`, announced after the commit, fenced, never for a refusal:

```ts
| { type: 'appeal.created'; appealId: string; createdAt: number; target: StaffRef; kind: SanctionKind; rule: RuleRef | null }
| { type: 'appeal.decided'; appealId: string; at: number; target: StaffRef; outcome: AppealOutcome; rule: RuleRef | null }
```

Like `report.created`, they carry ids, codes and times and **never the statement, the reason or the player's handle**. `moot` closures
announce nothing. `webhooksOut` accepts the two types in `events` (its validation reads `KIT_EVENT_TYPES`), and `includeExcerpts`
stays a `report.created`-only option: no setting puts a statement in a webhook. The Discord feed (`packages/discord/src/feed.ts`,
which has one handler per event) gains `onAppealCreated` and `onAppealDecided` posts to the person's thread ("Appeal filed against a
24-hour chat restriction, Rule 2. Open in the hub." / "Appeal decided: lighter."), the hub link being the existing
`hubLink('person', ref)` since an appeal belongs to a person; with `severeOnly`, only appeals on severe rules post.

## 5. Part B: names

### 5.1 What exists, and what changes

`cw.names.check(text)` and `POST /names/check` exist today (0.1.0 onward): matcher name rules only, no profanity, no memory, answer
`{ ok: true }` or `{ ok: false, reason: 'name_not_allowed', rule }`, no text echoed, limited to 20 a minute per identity, and it fails
open if the matcher throws. That stays the contract. This part extends it compatibly and adds the pieces around it.

A new optional profile field, `names`, in code and as an editable section (`'names'` appended to `POLICY_SECTIONS`):

```ts
// packages/core/src/names.ts (new)

/** @experimental */
export interface NameSettings {
  /** Also refuse a name the profanity filter flags. Default false (a swear word is not a slur; this is for a family game). */
  profanity?: boolean;
  /** Keep a blocked name, with the term it hit, as evidence. Default false: a name check stores nothing. */
  keepBlocked?: boolean;
  /** May a moderator require a rename from the Person page? Default false. */
  renames?: boolean;
  /** Mask a name the matcher flags in the hub until a moderator shows it. Default true. */
  maskInHub?: boolean;
}
/** @experimental */
export interface ResolvedNames { profanity: boolean; keepBlocked: boolean; renames: boolean; maskInHub: boolean }
```

### 5.2 The check

```ts
export type NameReason = 'name_not_allowed' | 'name_profane';
export type NameCheckResult = { ok: true } | { ok: false; reason: NameReason; rule: number };

// on Chatwarden['names']
/**
 * May a player use this as a name (a handle, a table or deck name)? Synchronous, never echoes the name, never throws for a string (a
 * non-string is still a TypeError). Reads it with the matcher's name rules, as before; with `names.profanity` it also runs the profanity
 * filter on the name and on the name with underscores and digits turned into spaces, and a hit is `name_profane`. A matcher or filter
 * that throws lets the name through (logged by class). `rule` is the Community Rule the slur filter cites (`autoRestrictRule`).
 *
 * `opts.who`: the caller, as the doors take it. It is used ONLY to tie kept evidence to a person (below); it never changes the answer.
 * A blocked name is stored only when `names.keepBlocked` is on; an allowed name is never stored; a name is never logged.
 */
check(text: string, opts?: { who?: RawWho }): NameCheckResult;
```

`reason` is the reason id, the same short code a screen switches on, never the text. `name_profane` is a new value of an existing field;
an adopter that only compares with `'name_not_allowed'` is unaffected as long as `names.profanity` stays off.

**Evidence, only on opt-in.** When the result is blocked and `names.keepBlocked` is on, the facade writes a `kit_blocked_names` row
(`name`, the `termId` the matcher reported, the reason, the time, and the person if `opts.who` finds one; the person is found, never
created). It is bounded so probing cannot fill the table: at most 5 rows an hour per person and 200 an hour overall (in memory, per
process); beyond that the check still answers, and nothing more is stored. The staff `GET /blocked?source=name` lists them; retention
is in 6.3.

### 5.3 Requiring a rename

```ts
// on Chatwarden['names']
/**
 * Ask a player to choose a new name. Writes a notice of kind `rename_required` (it names no name) and, after the commit, emits
 * `rename.required`. Staff only. `{ ok: false, error: 'off' }` while `names.renames` is false; `not_found` for a person the kit does not
 * hold; `pending` while one is already waiting. `reason` is private (1 to 500 characters, like a sanction's); `rule` defaults to the slur
 * filter's rule and is shown to the player as a rule label.
 */
requireRename(input: { subject: SubjectId; actor: string; reason: string; rule?: number }): { ok: true; noticeId: string } | { ok: false; error: 'off' | 'not_found' | 'pending' | 'invalid' };
/** True while the person has a rename request they have not been released from. For the game, to hold a player at a rename screen. */
pendingRename(who: RawWho): boolean;
/** The game calls this once the player has a new name. Withdraws their pending rename notices. True when it withdrew one. */
renamed(who: RawWho): boolean;
```

The kit never learns the new name and never checks that one was chosen; `renamed` is the game saying so. A player who never renames
stays `pendingRename` until the game releases them, and the hub's Person page shows the request as pending.

The notice (kind `rename_required`) carries the rule label and the time and nothing else: no old name, no excerpt. It is not a
sanction (no appeal link, not on "My record"), and `mustAcknowledge` is false: whether the player may keep playing is the game's call,
made with `pendingRename`.

### 5.4 Telling the game

```ts
// appended to KitEvent and KIT_EVENT_TYPES
| { type: 'rename.required'; at: number; target: StaffRef; rule: RuleRef | null }
```

The game needs to know which of **its** players this is, and a staff ref is the kit's, not the game's. Two ways, both opt-in:

- **In process:** `cw.on('rename.required', ...)` then a new staff-side read, `cw.people.accountIds(subject): string[]`, which returns the
  account ids the kit holds for that person across their merged aliases (the strings the game itself passed as `RawWho.accountId`;
  `SubjectIndex.identifiersOf` already has them). It is documented "server side only: never send to a player", like the other staff
  reads. A person with no account (a guest) has none; the game can still show the notice but has nothing to rename.
- **By webhook:** `WebhookEndpoint` gains `includeAccounts?: boolean` (default false), mirroring `includeExcerpts`: when true, a
  `rename.required` delivery's `data` also carries `accounts: string[]`, fetched with `cw.people.accountIds` when the event is raised.
  The warning in its TSDoc says an account id is the game's own identifier and goes only to a receiver the game controls.
  `webhooksOut` takes `Pick<Chatwarden, 'on' | 'reports' | 'people'>`. The event is also accepted in `events`, and the Discord feed
  ignores it.

### 5.5 Masking names in the hub

Today a handle is shown as typed everywhere it appears (queue rows, the case card, the Person page, the transcript's speaker names,
the command bar). With `names.maskInHub` (default on), a handle the matcher flags is masked the way a blocked chat line is: replaced by
the same "hidden" placeholder (`hub.mask.label`) with a Show control, and revealed per place or with the case's existing "show all".

- **Server:** every staff payload that carries a handle gains `handleFlagged?: boolean` (true only when flagged; absent otherwise, so
  unflagged bodies are unchanged), computed with `cw.names.check(handle)`. The surfaces are the ones that already call `latestHandle`
  or carry `targetHandle`/`reporterHandle`/line `handle`: `GET /reports`, `GET /reports/:id`, `GET /people/:ref/history`,
  `GET /sanctions`, `GET /blocked`, `GET /appeals`. A matcher failure reads as not flagged.
- **Hub:** one helper, `displayName(t, { handle, flagged, revealed })` beside `groupName` in `labels.ts`, becomes the only way a handle is
  turned into text (a lint-style test greps for raw `.handle` rendering), and `PersonChip` (`ui.tsx`), the transcript speaker, the
  command bar entries and `SimpleNav` use it. The existing `useCase().reveal` state is extended with `shows(handleKey)` rather than a
  second mechanism.
- The setting is read from the effective profile; with it off the hub shows names as before.

### 5.6 Hub UI for names

- **Person page, inside the existing action area.** No new button. The **Sanction** form's "What" selector (`KINDS` in
  `person/SanctionForm.tsx`) gains one last option, "Ask for a new name (no sanction)", present only when `names.renames` is on and the
  caller can apply sanctions. Choosing it hides the length and IP fields and keeps the rule and reason fields; submitting calls
  `POST /people/:ref/rename`. The same claim rules, validation and toast as a sanction. With renames off, the form is what it is
  today.
- **Settings, Advanced, "Names" panel:** four switches with one sentence each (check swearing in names; keep blocked names as evidence,
  with the retention in words; let moderators ask for a new name; hide flagged names until shown).
- **Blocked screen:** when `keepBlocked` is on, the existing filter row of the Blocked screen gains a "Names" choice
  (`GET /blocked?source=name`). No menu entry.
- Simple mode gets nothing new from names.

### 5.7 Player UI and words

player-react has no sign-up form (the game owns it). It gets words for the two new messages and a helper for the check:

| Key | English |
| --- | --- |
| `player.notice.title.rename_required` | Please choose a new name |
| `player.notice.body.rename_required` | A moderator asked you to change your name because it breaks the community rules. Choose a new name to keep playing. |
| `player.name.not_allowed` | That name is not allowed. Choose another. |
| `player.name.profane` | That name is not allowed here. Choose another. |

`nameReasonText(t, reason)` (new, `@experimental`, exported) turns a `NameReason` into the right string for a sign-up screen to show next
to its field. The `rename_required` notice appears in `NoticeQueue` as a plain message with "Got it"; the game's own rename screen does
the rest.

## 6. Audit actions, privacy, retention

### 6.1 Audit actions added

Appended to `AUDIT_ACTIONS` after whatever 0.1.7 and 0.1.6 left at the end (the list is append-only and the test that locks its order
allows later appends); `auditLabel.ts` in hub-react gets a label for each:

| Action | Target | When |
| --- | --- | --- |
| `appeal.view` | `appeal` (or none for the list and stats) | A staff read of the inbox, one appeal, or the numbers |
| `appeal.decide` | `appeal` | An appeal was decided (best effort after the write, like `sanction.apply`) |
| `name.rename_required` | `person` | A moderator required a rename |

`AUDIT_TARGET_TYPES` gains `'appeal'` (appended). Setting changes are `policy.update`/`policy.reset` with the section names `appeals` and
`names`, never values. Filing an appeal is not a staff action and is not audited; the appeal row is its record.

### 6.2 Privacy

- **The statement is the only new player free text.** It is stored in `kit_appeals.statement` and nowhere else: not in an event, a
  webhook, a Discord post, a notice, an audit row, a log line, or an AI prompt. It reaches staff only on `GET /appeals/:id`, which is
  audited, and the hub masks it when it trips the term filter.
- A player-facing answer carries no staff ref, no moderator, no reason and no sanction or person id: `PlayerAppeal` is an id, a notice id,
  a status and two times. `not_found` is one answer for "not yours", "no such notice" and "appeals off", so notice ids cannot be probed.
- A name check answers a reason id and a rule number. It stores nothing unless blocked and opted in; what it stores is the name, the term
  id and a person, for staff, on a short clock (below).
- A required-rename notice names no name. The event carries a staff ref, a time and a rule; account ids leave only under
  `includeAccounts` or through the staff-side `people.accountIds`.
- **Logs** carry event names and error classes only: `chatwarden.appeal_failed { error }`, `chatwarden.names_matcher_failed { error }`
  (exists), `chatwarden.names_filter_failed { error }`, `chatwarden.rename_failed { error }`. Never a statement, a name, a handle, a token,
  or an id.

### 6.3 Retention

New `RetentionPolicy` fields (defaults added to `RETENTION_DEFAULTS`; `FIELDS` and `checkRetentionFloors` in `retention.ts`):

| Field | Default | Floor | What it removes |
| --- | --- | --- | --- |
| `appealStatementsMs` | 90 days | none (0 clears a statement at decision) | `kit_appeals.statement` set to NULL this long after `decided_at`. An open appeal's statement is kept until it is decided. |
| `appealsMs` | 365 days | 90 days | decided `kit_appeals` rows this long after `decided_at`. The rate and the casebook read these; 90 is the stats window. |
| `blockedNamesMs` | 30 days | none | `kit_blocked_names` rows (the same clock as strikes). |

`purge()` does all of it in its existing transaction; `PurgeResult` gains `appeals`, `appealStatements` and `blockedNames`. Cutoffs are
strict like the others. The new notice kinds ride `noticesMs` (seen message notices are removed after it; an unseen `rename_required`
is kept). Statements follow report notes' rule that player text does not outlive its purpose, and are shorter than the row.

## 7. Tests that pin it

Test-first and broad, targeted runs only, fake clock throughout.

**Settings and layer (`appeals-settings.test.ts`, `names-settings.test.ts`, `policy-layer-appeals.test.ts`)**
- Defaults off for both; each field's bounds (perPlayerPerWeek 1 and 20 accepted, 0 and 21 refused); unknown keys refused with paths;
  `allowSelfReview` only boolean; `appeals`/`names` editable sections, reset restores the base, audit rows carry section names only.
- With both off, `cw` behaves as 0.1.7 (golden bodies and results).

**Filing (`appeals-file.test.ts`)**
- Happy path for each of the four sanction kinds; refusals in order: off; another player's notice, an unknown id and a malformed id are all
  `not_found`; a `report_outcome`, a `rename_required`, an outcome notice and a withdrawn notice are `not_appealable`; empty,
  whitespace-only, 1001 characters and control-only statements are `statement_invalid`, 1000 characters is accepted, 1000 counts code
  points (an emoji is one); control, bidi and zero-width characters are stripped, blank-line runs collapsed; `already_appealed` on a
  second file for the same sanction, also after the first was decided, also from a merged alias; `rate` at `perPlayerPerWeek` with the
  exact `retryAfterMs`, and again accepted once the oldest leaves the window; a refusal writes no row; a reduced sanction's replacement
  can be appealed once.
- Expired sanctions: a warning at 89 days appealable, at 91 not; a timed sanction ended 10 days ago appealable; a permanent ban
  appealable until revoked.
- Concurrency: two simultaneous files on one database leave one row (contract); the loser is `already_appealed`.
- The statement never appears in any event, log (a spy logger asserts event names and classes only), notice, audit row or webhook body.

**Deciding (`appeals-decide.test.ts`)**
- uphold: status, outcome notice, sanction untouched. revoke: group revoked, original notice withdrawn, outcome notice, index updated
  (chat accepted again at once). reduce: replacement written with the original start, rule and room; kind lighter and same-kind shorter
  accepted, equal, longer, heavier, `note`, and `to` with another outcome refused `invalid`; permanent-to-24-hours accepted;
  reduce from a warning refused; the ladder's step after a reduce-to-warning is computed from the original start; the replacement's
  notice is created and the player's pending count is announced after commit.
- Atomicity: a failure in any step leaves the appeal open, the sanction untouched and no notice (inject a throwing store); a second
  decide is `already_decided`; two concurrent decides leave one outcome.
- Independence: the original actor is `same_decider`; another actor passes; an automated sanction has no decider; `allowSelfReview` on
  passes the original actor; a webhook actor and a human differ; the check is in the core (a direct `cw.appeals.decide` is refused).
- `moot`: revoking a sanction elsewhere closes its open appeal, no outcome notice, no count as granted; revoking a sanction with no
  appeal does nothing extra.
- Events: `appeal.created` and `appeal.decided` after the commit, once, never on a refusal or `moot`, carrying no statement or reason.

**Stats and the AI (`appeals-stats.test.ts`, in the AI test folder)**
- Per rule: sanctions counted (notes excluded), appealed, granted (reduced and revoked only; upheld and moot excluded), `rate` null
  below 10 sanctions and exact at 10, bands at 0.15 and 0.30 exact edges, `uncovered` last, window edges strict, empty store.
- `markReversed(reportId)` is called for reduce and revoke and not for uphold or moot; a missing `report_id` (old sanction) is skipped;
  with no AI, nothing fails; the reversed row is excluded from examples; a corrective row is used at most once per read, only past 30
  teachable rows, never counted toward them; a corrective row with no example text teaches nothing but still counts in the rate.
- `AIReadInput.cautions` lists only elevated and high rules, carries bands and rule numbers only, and the input hash is unchanged by it.
- The statement is absent from every AI input (a test scans the rendered prompt).

**Names (`names-check.test.ts`, `names-rename.test.ts`)**
- Unchanged: allowed, blocked by the matcher (`Zorbak_99`-style variants with the synthetic terms), no matcher, a throwing matcher,
  a non-string `TypeError`; the answer holds no name.
- Profanity pass off by default; on, a profane name is `name_profane`, a clean one allowed, underscores and digits split, a throwing
  filter lets the name through; the matcher hit wins when both fire.
- Evidence: nothing is stored by default (spy store); blocked and `keepBlocked` stores one row with the term and the person when
  `who` finds one, NULL otherwise; an allowed name is never stored; the hourly caps hold; `who` never changes the answer; a store
  failure is absorbed.
- `requireRename`: off, not_found, pending, invalid, success; one notice, kind `rename_required`, no excerpt, no name; the event after
  commit; `pendingRename` true until `renamed` or withdrawal; `renamed` returns false when nothing was pending; the notice is not
  on "My record", not appealable, not `mustAcknowledge`.
- `cw.people.accountIds`: aliases folded, guests empty, sorted; `webhooksOut` adds `accounts` only with `includeAccounts`, and never
  for another event type.

**Store (`test/contract/appeals.contract.ts`, `names.contract.ts`; `store-sqlite/test/migrations`)**
- All methods on both stores; the unique group; conditional decide; counts by rule; strict purge edges; clear-statements keeps the row.
- Migration 22: from a version-21 database with real notices of every old kind (rows survive the rebuild with the same ids, order and
  indexes), with decisions and sanctions (the backfill links the right report, leaves unmatched rows NULL), from empty, with and
  without the AI tables; the new CHECK accepts the four kinds and refuses a fifth; rerun refused.

**Retention (`retention.test.ts` additions)**
- Defaults; `appealsMs` below 90 days refused; non-finite refused; `purge` reports its three counts; an open appeal's statement
  survives; the notice purge keeps an unseen `rename_required`.

**HTTP (`admin.appeals.test.ts`, `player.appeals.test.ts`, `admin.names.test.ts`)**
- Every route's permission boundary at moderator, senior and owner (`appeals.decide` defaulting to senior, lowered by the option);
  audit rows and modes (list/stats/detail required, decide best-effort); invalid query, cursor, outcome and body shapes are 400 with
  the kit's error codes; 404/409/429 mappings and `retry-after`; the request limiter; appeals off means 404 everywhere and unchanged
  `GET /me`, `GET /changes`, `GET /people/:ref/history`; the player body holds only the documented fields (the `no-leak` suite);
  `/appeals/stats` is not captured by `/appeals/:id`.
- `POST /people/:ref/rename`: needs `sanctions.apply`, honours the claim gate and `takeOver`, 404 when renames are off.
- `handleFlagged` appears only when flagged, only with `maskInHub`; a matcher failure reads as unflagged.

**Hub (`appeals-queue.test.tsx`, `appeal-card.test.tsx`, `person-rename.test.tsx`, `names-mask.test.tsx`, `a11y-appeals.test.tsx`)**
- The Reports | Appeals switch is absent with appeals off or without `appeals.read` (DOM snapshot of the queue pane unchanged); Simple's
  one line renders only with count above zero and never otherwise; Simple's menu is unchanged.
- The card masks a flagged statement and reveals per statement and for all; renders statement text as text (a `<script>` string is
  inert); decision controls validate the reason, disable Make-it-lighter for a warning, offer only lighter choices from the profile's
  durations, show `same_decider` in words and keep what was typed; a decided appeal returns to the list.
- The Sanction form shows the rename choice only with `names.renames` and the permission, hides length and IP fields for it, and the
  Person page shows appeal and rename entries in the timeline with no new element elsewhere.
- Masked names: every surface that shows a handle goes through `displayName` (a grep-style test); flagged names are masked by default and
  shown with the control; `maskInHub` off shows names as before.
- The public API snapshot (`api.test.ts`, `apiNames.ts`) is updated deliberately; a11y checks (axe) pass for the new surfaces; 360 px
  and light/dark are checked in a real browser.

**Player (`appeal-dialog.test.tsx`, `appeal-notices.test.tsx`, `name-text.test.ts`)**
- Without `appeals`, `NoticeQueue` and `MyRecord` render exactly the `appealUrl` link of 0.1.7; with it, a button opens the dialog;
  counting, the cap, Send disabled when empty, each refusal in words, focus return and Escape; the sent state replaces the button; the
  outcome notices render with their titles and one "Got it"; an old catalog falls back to the generic title; `rename_required` shows;
  `nameReasonText` covers both reasons; no identifier appears in any answer (`no-leak.test.tsx`); `size.test.ts` holds.

**Discord and webhooks**
- The feed posts for `appeal.created` and `appeal.decided` with no statement, no handle and no reason; `severeOnly` filters; the
  message fits the post limit; `webhooksOut` accepts the types, signs them, and never adds the statement; `rename.required` is ignored by Discord.

## 8. Risks

- **A one-way migration.** The notices table is rebuilt, so a 22 database cannot go back to 0.1.7. Mitigation: the release notes, a
  documented backup step, and the rebuild pattern already used twice.
- **Abusive statements.** A player can write anything. Mitigations: 1000 characters, plain text only, masked when it trips the filter,
  a weekly cap, one appeal per sanction, and the existing "take a break" nudge. The hub never renders it as markup.
- **The backfill is a substring match** over decision JSON. It is bounded by kit scale, and unmatched rows only lose the casebook link.
- **Self-review in small teams.** `allowSelfReview` exists because a team of one has no one else. It is a kit-wide switch and a recorded
  policy change; it is not hidden.
- **Appeal flooding by many accounts.** The cap is per person. An abuser with many accounts can file many, each against its own
  sanction, which is the sanctions they own. The inbox is oldest first and not a reason to skip real work.
- **Type widening in a patch.** `NoticeKind` gains four members and `RefuseReason` gained three in 0.1.7. Older player-react falls back to
  the generic title; an adopter with an exhaustive `switch` over `NoticeKind` gets a compile error to fix. The changeset's first line says so.
- **Dependence on the AI branch.** `markReversed`'s second argument, `AIExample.kind`, `cautions`, and the `corrective` column are
  additions to 0.1.6 code. If 0.1.6's shape differs, only the adapter between the appeals service and `cw.ai` changes.
- **Names masking changes what an existing install shows**, but only for flagged handles and only on screen. Question 4.
- **A required rename depends on the game.** The kit cannot make a game rename anyone; a game that ignores `rename.required` leaves a
  notice nobody acts on. The README says what the game must do.

## 9. Not in this release

- Appeals by reporters, appeals of notes, or of anything without a notice.
- A free-text reply to the player, or a second appeal after a decision.
- Claims on appeals (the conditional decide is the guard); keys for the appeal card.
- A per-actor or per-role self-review exemption; routing appeals to a named moderator; an SLA clock.
- Auto-expiry of an old open appeal.
- The kit holding or checking a player's current name; automatic renames; checking names already in the game (a batch scan).
- A webhook that carries a statement or a name; the AI reading a statement or a name.
- Gates for AI levels 3 and 4 (they will read `appeals.stats`).
- A locale other than English for the new words (the keys are flat, so translations are additive).
- Site copy. It flips a promise only after the release is on npm and has run in Moxgate.

## 10. Rollout and docs

- One changeset, patch, in the fixed group (0.1.8); the first line says "adds notice kinds and a one-way migration". Peer floors raised by hand.
- `@experimental` on every new name: `AppealSettings`, `ResolvedAppeals`, `cw.appeals.*` and its types, `NameSettings`, `requireRename`,
  `pendingRename`, `renamed`, `people.accountIds`, `AppealDialog`, `nameReasonText`, `includeAccounts`, `appeals` props of the player
  components. Listed in the READMEs until 0.2.
- Docs: core README (appeals, names, the event list, retention), http README (the routes and `permissions`), player-react README
  (`appeals` prop, the dialog, words), hub-react README, discord README (the two posts). The audit label table in hub-react.
- Locked exports updated deliberately: hub-react `api.test.ts`/`apiNames.ts`, player-react `static.test.ts`, the `AUDIT_ACTIONS` order
  test (append), `KIT_EVENT_TYPES`.

## 11. Open questions

Each has a recommendation; the controller rules.

1. **One appeal per sanction for its lifetime, or one open at a time.** *Recommended: lifetime.* A second appeal after an uphold only
   restarts the argument, and a reduced sanction already gets a fresh one.
2. **Default role to decide.** `senior`, lowered by option. *Recommended: senior,* so a default install separates reading from
   deciding; the README shows the one-line change for small teams.
3. **Self-review.** Refuse by default, with one kit-wide switch. *Recommended: as written.*
4. **Masking flagged names by default.** The only change to what an existing install shows. *Recommended: default on,* since it is
   display-only, protects the people reading, and matches the owner's ruling that names are masked like chat lines; the switch turns it off.
5. **Notice kinds.** Four separate kinds (this note) or one `appeal_outcome` with an outcome field. *Recommended: four,* so
   `PlayerNotice` keeps its shape and an old client degrades to the generic title.
6. **Reducing keeps the original start time.** *Recommended: yes,* so a reduction lightens the ladder step and the record, not only the length.
7. **Statement and row retention.** 90 days after the decision for the text, 365 for the row. *Recommended: as written.*
8. **`rename.required` and account ids.** Not in the event; opt-in `includeAccounts` on the webhook and `people.accountIds` in process.
   *Recommended: as written,* so the default event holds no game identifier.

## 12. Rulings

*(To be filled by the controller when the questions above are answered.)*

## Rulings (2026-11-12, controller, under the owner's "continue autonomous until you finish the entire chatwarden roadmap")
All eight open questions take the recommendation:
1. One appeal per sanction for its lifetime.
2. `appeals.decide` defaults to `senior`, lowered through the `permissions` option.
3. Core refuses an appeal decided by the original decider; one kit-wide `allowSelfReview` switch serves a team of one.
4. Matcher-flagged names are masked in the hub by default (a setting).
5. Four notice kinds (`rename_required`, `appeal_upheld`, `appeal_reduced`, `appeal_revoked`); migration 22 rebuilds `kit_notices`.
6. A reduced sanction keeps the original start time.
7. Appeal statements are kept 90 days after the decision; the appeal row 365 days.
8. `rename.required` carries no account ids unless the adopter opts in (`includeAccounts`, `cw.people.accountIds`).
Sequencing: follows 0.1.7 and takes SQLite migration 22.

### Plan-time rulings (2026-11-12, from writing docs/plans/2026-11-12-appeals-and-names.md)
Accepted as the plan states them: 1 (a reduction ends at `min(original end, start + to.durationMs)`, never later than the original, written already ended if past), 2 (`name_profane` reuses `autoRestrictRule`; players see a reason sentence), 3 (`cw.names.flagged(text): boolean`, matcher only, never stores, never throws, for staff paths), 4 (`BlockedNameRow = { id; subject: SubjectId | null; name; termId: string | null; reason: NameReason; at }`), 6 (the rate counts distinct sanction groups and excludes replacement groups), 7 (`purgeAppeals` skips appeals on permanent, unrevoked sanctions), 8 (moot appeals are omitted from `mine()` and `GET /appeals`), 9 (`clearStatement` at decision when `appealStatementsMs` is 0), 10 (migration 22 rebuilds `kit_notices` from the live schema), 11 (`SANCTION_KIND_ORDER` = warning, chat, area, ban), 12 (filing, deciding and moot bump `cw.changes`), 13 (`markReversed` is exposed on `cw.ai` if it is not already), 14 (peer floors: store-memory, store-sqlite, http, discord on core `^0.1.8`; hub-react on core and http `^0.1.8`; player-react only if it imports a new core name), 15 (read the hub budget from size.test.ts after the rebase).

Ruling 5, changed by the controller: a REDUCE is not a false positive (the rule applied; the sanction was too heavy). A reduce marks the original decision reversed (so it is never a positive casebook example) and teaches nothing, and it is NOT counted in the per-rule false-positive rate; the hub shows it beside the rate as "made lighter on appeal". Only a REVOKE counts toward the false-positive rate and adds the corrective example (`{ corrective: true }`). This narrows "granted appeals" in the sections above to revokes wherever the false-positive rate or the AI cautions are concerned. Why: the owner's intent is to cut false positives; counting severity disputes as false positives would make the AI hesitate on rules that were applied correctly. Cost if wrong: one line in the stats query and the cautions band.
