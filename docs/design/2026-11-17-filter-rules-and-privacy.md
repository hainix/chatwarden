---
status: draft, awaiting controller rulings (section 15)
updated: 2026-11-17
release: 0.2.0
---

# Chat filter rules, privacy requests, and legal hold

Three gaps from `2026-11-17-moderation-coverage-audit.md`, built as two themes of the one release that settles the `@experimental` names (0.2.0):

- **Theme A, chat filter rules (G1):** a small, declarative rule set in the profile layer that sees a line after the slur matcher and before
  profanity: links, personal info, phrases (ads, scams, RMT), and caps or repeat floods. Each rule has an action and its own Community Rule
  number. Nothing is on until an owner turns it on, and a filter never writes a strike, a sanction or a timeout.
- **Theme B, privacy requests (G2):** `cw.privacy.export` and `cw.privacy.erase` for one person, owner only, audited, with a receipt.
- **Theme B, legal hold and evidence bundle (G5):** a senior holds one report past the purge, the owner downloads a signed JSON bundle,
  and the game's own process hears `report.escalated` (ids only).

The release has no users yet, so there are no compatibility shims in this note: where an existing API is clumsy for the new work it is
changed, and every such change is listed in section 13. Text chat only: images, media and voice are out of scope. The kit gives the adopter
mechanisms. Whether a line is a crime, whether a request must be honoured, and what to keep are the adopter's decisions (section 12).

Not designed here (other themes of the same release): names inside reports and the "what the player sees" preview; the urgent lane, the
case desk and room tools; many rooms, any server and languages. Section 14 lists the interfaces this note needs from them.

## 1. Why

**Filters.** The only thing the chat path knows is slurs and swearing. A link, a phone number, a gold-selling line or a wall of capitals
reaches the room before anyone can report it; the only workarounds today are the game's `gate` hook, or a word stuffed into the term list,
where a hit is an automatic timeout under rule 1 (slurs), which is the wrong rule and a heavy answer to an advert. An owner needs to say
"refuse a link unless the domain is mine", "hide phone numbers", "send any line with `buy gold` to the queue", each citing its own rule,
with a way to try the rule on real lines before it acts, and a count of what it did.

**Privacy.** An adopter with players in the EU, UK or California is asked "what do you hold about me?" and "delete me" within months. Today
the answer is "edit the database" (the SQLite README says so and warns about `kit_claims`). The subject, identifier, Discord thread and
other tables are never purged. The dangerous failure is a partial erase that leaves a way to re-link the person, so the design starts from
"enumerate every place a subject id lives" and pins it with a test that fails when a table is added without a decision.

**Legal hold.** A report purges after 90 days. When a credible threat or a legal process needs it kept, the workaround is raising
`retention` for everyone and exporting by hand. A senior needs to hold one case, and an owner needs one signed file to hand to counsel.

## 2. Goals and non-goals

### Goals
- Four filter kinds (links, personal info, phrases, ratios), four actions (`count`, `flag`, `mask`, `refuse`), each rule citing a
  Community Rule, evaluated in one linear pass with a fixed budget per line.
- Filters can be tried before they act: a "Test a message" box, a dry run over recent lines, and the `count` action, which counts what a
  rule would do on real traffic without touching a line.
- Never silent: a refused author is told which kind (`link`, `personal_info`, `filter`) and the rule; a masked line is delivered masked and
  the author sees what was delivered.
- A hit is a counter row with no person in it. A `flag` is a report with no reporter that a person decides.
- `export` of one person's data as one JSON file; `erase` that removes everything the kit may remove, keeps only a stated safety
  remainder, and returns a receipt that holds no personal data.
- A hold that stops retention and erase from touching one report and what hangs off it; a signed bundle; one event.
- Every table that can hold a subject id is classified, and a test makes an unclassified new table fail.

### Non-goals
- Judging legality (section 12), reporting to anyone, verifying who a requester is, contacting a player, or telling a player about an erase.
- Any URL fetch, resolve, preview or reputation lookup; any model or score in the filters. Filters are deterministic text rules.
- Regular expressions supplied by an owner. The pattern vocabulary is fixed (section 4.5).
- Reading spaced-out letters (`g o l d`), spoken digits ("five five five"), or text inside images (same ruling as audit E2).
- A player-facing privacy route. Requests reach the adopter by the adopter's own means; the kit has no player endpoint for them.
- Per-person filter counters or filter strikes. A filter never changes a person's record by itself.
- Multi-room profiles (`contexts`) and room lock or emergency modes (other themes); this note only makes filters resolvable per room.

## 3. Where it sits

```
chat.accept:  trim, seat, gate, restriction, length, pacing, rate, pacing commit,
              matcher hit  -> strike, 'blocked'                      (unchanged; filters do not run on a blocked line)
              FILTERS (new)  link, personal info, phrase, ratio      -> refuse | mask | flag | count
              profanity (on the masked text)
              buffer the delivered line, then any `flag` report
```

A filter refusal behaves like a profanity refusal: not buffered, no strike, no notice, and it has spent the line's rate and pacing
budget. The refused text is never stored anywhere; the author is told the kind and the rule number, never the matched part.

## 4. Theme A: chat filters

### 4.1 Settings

A new optional profile field `filters`, an editable layer section appended to `POLICY_SECTIONS` as `'filters'`, validated like `pace`
(`ProfileError` with the path, never echoing a value), merged by the pace rules: a field left out inherits, `null` turns a block off, an
array or object value replaces whole. The presets ship it unset. Suggested values exist (below) and are never applied by themselves.

```ts
// packages/core/src/filters.ts (new)
export const FILTER_ACTIONS = ['count', 'flag', 'mask', 'refuse'] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

/** @experimental */
export interface FilterSettings {
  links?: LinkSettings | null;
  personalInfo?: PersonalInfoSettings | null;
  /** Up to 20 rules. Replaced whole by a layer. */
  phrases?: PhraseRuleSettings[];
  ratio?: RatioSettings | null;
  /** Phrases removed from a line before any filter reads it ("1 2 3 4 5 6 7 8 9", "e.g."). Up to 50, each 1 to 60 characters. */
  ignore?: string[];
  /** The most `flag` reports the filters file in one UTC day. 1 to 500, default 50. Past it a `flag` counts only. */
  flagCapPerDay?: number;
}

export interface LinkSettings {
  action: FilterAction;                 // required
  rule?: number;                        // a Community Rule number; default 4
  allow?: string[];                     // up to 100 domains
  deny?: string[];                      // up to 100 domains
  unlisted?: 'act' | 'allow';           // a link on neither list. Default 'act'
  invites?: boolean;                    // built-in invite links (Discord, Telegram, WhatsApp, ...). Default true
  shorteners?: boolean;                 // built-in URL shorteners. Default true
  /** Links from an account younger than this many days are acted on even if `unlisted` is 'allow' (the allow list still passes). 1 to 365, default null (off). Needs `signals.accountAgeDays`. */
  newAccountDays?: number | null;
}
export interface PersonalInfoSettings {
  action: FilterAction;
  rule?: number;                        // default 2
  kinds?: Array<'phone' | 'email' | 'card' | 'contact'>;   // default all four
  phone?: 'formatted' | 'any';          // default 'formatted'
  /** A street address by heuristic. Only ever counts or flags (never hides or refuses). Default null (off). */
  address?: 'count' | 'flag' | null;
}
export interface PhraseRuleSettings {
  id: string;                           // ^[a-z][a-z0-9_-]{0,31}$, unique; it is the counter key
  label?: string;                       // up to 40 characters, shown in the hub and on the queue chip
  action: FilterAction;
  rule?: number;                        // default 4
  phrases: string[];                    // 1 to 100 patterns (section 4.5)
}
export interface RatioSettings {
  action: FilterAction;                 // 'mask' means soften (below)
  rule?: number;                        // default 4
  caps?: { minLetters?: number; maxPercent?: number } | null;     // 8..200 (12), 50..100 (70)
  repeats?: { maxRun?: number } | null;                           // 3..50 (6)
  emoji?: { max?: number } | null;                                // 1..50 (8)
  mentions?: { max?: number } | null;                             // 1..20 (3)
}
```

`ResolvedFilters` has every field filled and every list normalised (domains lowercased, phrases compiled lazily). `ResolvedProfile.filters`
is it. Rules named by `rule` must be the number of an active Community Rule: checked at creation and on every layer save, like
`autoRestrictRule`; a rule later switched off makes the next save fail, not the chat path (an inactive rule is cited by number anyway).
Packs are all-or-nothing per kind: `links`, `personalInfo` and `ratio` are on when their block is present, off when absent or `null`.

**Suggested values** (`FILTER_SUGGESTIONS`, `@experimental`, offered behind a hub button): `relaxed` is everything absent; `standard` is
`links { action: 'flag' }`, `personalInfo { action: 'mask' }`; `strict` adds `ratio { action: 'mask' }` and `links` with
`newAccountDays: 2`, `action: 'refuse'`. A fourth set, `rmt`, is an English phrase rule (`buy|sell|selling|buying|cheap ~ gold|gp|coins|accounts|
boost|boosting|powerleveling`, action `flag`) shown as a template the owner edits.

### 4.2 The result

```ts
export type RefuseReason = ... | 'link' | 'personal_info' | 'filter';          // widened
// the refuse arm already carries `rule`; a filter refusal sets it to the rule the hit cites.
```
Phrase and ratio rules both answer `filter`. The refusal carries no matched text, no rule id of a phrase rule and no counter. The chat
box and `RestrictedChatLine` get one sentence each (section 8).

### 4.3 Evaluation order and composition

All enabled blocks are evaluated on the trimmed line (the first 2 000 characters; a longer line cannot reach the filters through `accept`,
which refuses over `limits.chatMaxLength`, but the engine still enforces its own cap). `ignore` phrases are blanked first (replaced by one
separator, offsets kept). Order inside the filters is fixed: links, personal info, phrases in list order, ratio. Then:

1. **Strongest action wins the line's fate:** `refuse` beats `mask` beats `flag` beats `count`. The refusal cites the first refusing hit in
   the fixed order.
2. `mask` hits do not stop the others: every `mask` span is replaced by `*` (reusing `maskSpans`); a ratio `mask` softens (caps: lowercase
   the line except the first letter of each sentence; repeats: shorten a run to `maxRun`; emoji and mentions: cut the extras). Profanity then
   runs on the masked text.
3. `flag` hits file at most one report per line (section 4.8). `count` hits only count.
4. Every hit writes one counter increment (4.7). A refused line increments only the hits that were evaluated before the refusal returned:
   evaluation does not stop at the first hit (all blocks run, so counters and the strongest action are complete), but a refusal returns
   once all blocks finished.

With every block off the engine builds no key, makes no lookup and allocates nothing (a test pins it, like pacing).

### 4.4 Links

**What counts.** Text only; never fetched, resolved or previewed. A link candidate is found by one forward scan over the line, with no
backtracking and a bounded step count. A candidate is any of:
- a token with a scheme (`scheme://`, any scheme; `hxxp` and `hxxps` read as `http`/`https`) or starting `www.`;
- a bare host: labels separated by a dot, whose last label is in the **strong TLD list** (about 120 common link TLDs: `com net org io gg
  tv xyz info biz app dev co ly gl ru cn uk de fr br es pt gov edu` and so on, excluding file-extension look-alikes `zip mov sh py pl rs md`
  and English words);
- a bare host whose last label is in the **weak list** (`me us in is it to at be so no my do hi as by am`) only when a path follows
  (`t.me/abc`): `this.is`, `check.in` and `ok.so` in a sentence with a missing space are not links;
- an IPv4 literal (four numbers 0 to 255; `3.14` and `1.2.3` are not), with or without a port;
- a scheme host that is a decimal, hex or octal integer (`http://3232235777`).

**Defanged and obfuscated forms** read as a dot: `[.]`, `(.)`, `{.}`, the full-width and ideographic dots (U+FF0E, U+3002, U+FF61), and
`dot`/`(dot)`/`[dot]` between two plain labels when the last label is a strong TLD. Zero-width, bidi and control characters are stripped
inside a candidate before it is read (offsets kept for masking). A space after a dot is not read: `evil. com` is a sentence.

**Host rules.** The authority ends at the first `/`, `?`, `#` or whitespace; the host is what follows the **last** `@`, so
`https://google.com@evil.com` is `evil.com`. Brackets give an IPv6 literal (any IPv6 is `unlisted` and cannot be allowed). A port is dropped.
A `%XX` in a host is decoded only when the result is ASCII letters, digits, `-` or `.`; any other host that does not parse as labels of
letters, digits, `-` and `_` (or non-ASCII letters) is still a link, with `unlisted` standing (it cannot be on the allow list, so it fails
closed). Hosts are lowercased (NFKC), a trailing dot is dropped, a label over 63 or a host over 253 characters is a parse failure.
Internationalised hosts are compared as written; punycode is not converted (list both forms to allow both). **A host with a non-ASCII
label is `unlisted` even when `unlisted` is `'allow'`**, so a look-alike of an allowed brand does not pass (it passes only if listed).

**Decision for one host**, in this order:
1. On `deny` (the entry or a parent domain): hit `deny`.
2. On `allow`: pass. An `allow` entry matches the host and its subdomains. An entry that is itself a shared hosting suffix from a built-in
   list (`github.io`, `gitlab.io`, `vercel.app`, `netlify.app`, `pages.dev`, `workers.dev`, `blogspot.com`, `herokuapp.com`, `web.app`,
   `firebaseapp.com`, `glitch.me`, `onrender.com`, `trycloudflare.com`, `ngrok.io`) is refused at save unless written exactly (`=name.github.io`),
   because allowing it would allow every user's page. `=` always means exact host. A domain on both lists is refused at save.
3. Built-in packs: `invites` (`discord.gg`, `discord.com/invite`, `discordapp.com/invite`, `dsc.gg`, `t.me` with `+` or `joinchat`,
   `chat.whatsapp.com`, `signal.group`) then `shorteners` (`bit.ly`, `t.co`, `tinyurl.com`, `goo.gl`, `is.gd`, `cutt.ly`, `rb.gy`, `ow.ly`,
   `buff.ly`, `shorturl.at`, `tiny.cc`, `v.gd`, `lnkd.in`, `rebrand.ly`, `t.ly`, `short.io`): hit `invite` or `shortener`. These lists are
   code, not settings; an owner adds to them through `deny` or exempts one through `allow`.
4. Otherwise: if `unlisted` is `'act'`, or the account is younger than `newAccountDays`: hit `unlisted` (or `new_account`); else pass.

The account age comes from the existing `signals.accountAgeDays(accountIds)` hook, called only for a line that holds an unlisted link and
only when `newAccountDays` is set; an unknown age (`null`, `undefined`, a throw) reads as not new. `GET /policy/profile` reports
`limits.filters.accountAge: boolean` so the hub can say "needs the account-age hook" instead of a switch that does nothing.

`mask` replaces the link text, scheme and path included, with `*`. An email address is never a link (`name@mail.com` goes to personal info),
and a game's own `cw.links` table is unrelated.

### 4.5 Phrases and the pattern vocabulary

A phrase rule is a list of patterns. A pattern is 1 to 6 space-separated tokens, 80 characters at most; a token is one of:

| Token | Meaning |
| --- | --- |
| `gold` | a whole word (after folding) |
| `buy\|sell\|selling` | any one of up to 8 alternatives |
| `gold*` | a word that starts with `gold` (`goldfarm`, `golds`) |
| `*` | exactly one word of any kind |
| `~` | zero to three words of any kind |

The first token must be a word, an alternation or a prefix (never `*` or `~`), and a pattern holds at most two `~`. There is no regular
expression and no backtracking beyond the bounded `~` (worst case 4 branches per `~`, so at most 16 per start position). Patterns are
compiled once per settings change into a map keyed by the first word, so a line costs one lookup per word plus the tail comparisons of the
patterns that share it. Limits: 20 rules, 100 patterns per rule, 500 in all.

**Folding** (the same view for patterns and lines; core carries its own, because it cannot import the matcher): split on whitespace and on
`- _ / \ | , ; : ! ? ( ) [ ] { } " ~ + = < >`; per chunk, NFKC, lowercase, strip accents and zero-width characters, drop `.` and `*`
between letters (`g.o.l.d`), collapse a run of three or more of one letter to one, and, only in a chunk that holds a letter, map the
look-alikes `0 1 3 4 5 7 @ $` to `o l e a s t a s` (so `g0ld` is `gold` and `500` is `500`). Spaced-out letters are not read (section 2). Offsets
map back to the original line for masking.

A pattern is rejected at save with the path when it breaks the grammar, starts with a wildcard, is shorter than 3 letters in its first word
(a 2-letter first word would match half the language), or folds to nothing.

### 4.6 Personal info

All detectors are hand-written scans, linear in the line.

- **Email.** `local@domain.tld` with a strong or weak TLD and a local part of 1 to 64 allowed characters; and the bracketed forms
  `[at]`, `(at)`, `{at}` with `[dot]`, `(dot)`. A bare " at " is never read.
- **Phone** (`formatted`, default): `+` and 8 to 15 digits with optional spaces, dots, dashes and parentheses; or 9 to 15 digits in 3 to 5
  groups where the groups follow a phone shape (an optional 1 to 4 digit prefix, then groups of 2 to 4 digits, separators from `space - . ( )`
  used consistently). Plain digit runs and lists such as `1500 2000 3000` are the known false positives of `any`; `formatted` also
  refuses to read a run whose groups are identical or arithmetically stepped (`100 200 300 400`, `10 20 30 40`). `phone: 'any'` reads
  any run of 9 to 15 digits allowing single separators. Numbers spelled in words are not read.
- **Card.** 13 to 19 digits with single spaces or dashes that pass the Luhn check.
- **Contact** (the "add me on" pattern): a lead word (`insta`, `instagram`, `snap`, `snapchat`, `discord`, `whatsapp`, `telegram`, `kik`,
  `tiktok`, `skype`, `signal`) followed within three words by a handle-shaped token: `@name`, `name#1234`, or 3 to 32 characters that
  hold a digit, `_`, `.` or `#`. `discord is down` does not match; `my snap is john_doe99` does.
- **Address** (`address`, only `count` or `flag`): a number of 1 to 5 digits, one or two words, then a street word (`street st avenue ave
  road rd boulevard blvd lane ln drive dr court ct`). A heuristic: it can never hide or refuse a line.

### 4.7 Hit counters

One row per (UTC day, key, action): `kit_filter_hits`, no person, no room, no text. `key` is `link`, `link.invite`..., `personal_info.phone`,
`phrase.<id>`, `ratio.caps` and so on (closed shapes). Increments are held in memory and written every 30 seconds and on `close()`: the chat
path never waits on a store write, and a crash loses at most 30 seconds of counts (documented; counts are for tuning, not for evidence).
`cw.filters.stats({ days: 7 | 30 })` flushes this process first and returns per key the counts by applied action (`count`, `flag`,
`mask`, `refuse`, and `flag_capped` when the daily cap turned a flag into a count). Retention: `filterHitsMs`, default 90 days, floor 30
days (the longest window the hub reads).

### 4.8 `flag`: a report with no reporter

A `flag` files one **system report** for the speaker, through a new `cw.reports.fileSystem({ origin, originKey, roomId, target, lineId })`
(the same call the AI Watch design names; `origin` is `'filter'` here and `'watch'` later). It is an ordinary open report: the excerpt is the
room's evidence snapshot, a person decides it, and nothing happens to the speaker until one does.

- **Shape.** `origin: 'filter'`, `originKey` is the counter key, `reportedReason` is `spam` (link, phrase, ratio) or `personal_info`, the
  note is null, there is no reporter: `reporterSubject` is `filter:<report id>` (a value that is never a subject id and never repeats),
  reporter seat and handle are empty. The staff view shows `reporter: null` and the chip "Filter: Links" (or the phrase rule's label).
- **No reporter effects.** No reporter notice on decision, no reporter accuracy or ranking, never counted toward a suspension, never marked
  bad faith, never in a reporter's bulk dismiss, skipped by the reporter outcome queries. `isSystemReport` reads `origin`, so AI level 3 still
  never acts on one (its existing rule).
- **Dedupe and caps.** At most one open filter report per (person, room): the insert is guarded by a partial unique index, and a refusal
  by it counts as `count`. At most `flagCapPerDay` filter reports a UTC day across the instance (counted from the store, so processes share
  it); past it a `flag` counts only. A speaker with no subject (a guest the kit cannot name) cannot be reported: the hit counts only.
- The event is the normal `report.created`, with `origin: 'filter'` (an id-class field). The AI read, if enabled, reads it like any report.

### 4.9 Dry run, test box and the `count` action

- **Test a message** (`POST /filters/test { text, candidate? }`): the verdict for one line under the live filters, or under a `candidate`
  settings object not yet saved: each hit's kind, detail, action, rule and matched ranges, and the line as it would be delivered. Nothing
  is stored or audited (the same precedent as `POST /terms/test`); the box shows the matched part to staff only.
- **Check my changes** (`POST /filters/check { candidate }`): runs the candidate over the adopter's `recentLines()` (the option the term dry
  run already takes) and returns counts per rule and up to 20 sample lines per rule, each with its ranges. The hub offers it before Save and
  asks for a confirm when a `refuse` or `mask` rule would touch more than 5% of the sample.
- **`count`** is the dry run on real traffic: set a rule to `count` for a week, read `GET /filters/stats`, then raise it.

### 4.10 What the player sees

New refusal words (flat keys; the English text is the fallback):

| Key | English |
| --- | --- |
| `player.refuse.link` | Links are not allowed in chat here. |
| `player.refuse.personal_info` | Please don't share personal details such as phone numbers or emails. |
| `player.refuse.filter` | That message was not sent. It breaks a chat rule. |

Each is followed by the rule's own label when `rule` is present, as `blocked` is today. A masked line shows the author the masked text,
because the box echoes what was delivered. Nothing says which pattern matched.

### 4.11 Hub

Settings, Advanced, **"Chat filters"** (lazy panel, owner edits, others read): four cards, Links, Personal info, Shouting and repeats,
Phrases, each a switch (off), a four-way action choice in words (Only count / Send to the queue / Hide the part / Don't send the line),
a rule picker, and the kind's details (domain lists as chips with a hint for `=`; the contact and address options; the numbers for caps,
repeats, emoji and mentions; phrase rules as a list with a one-line pattern help). Under the cards: **Test a message**, **Check my
changes**, and **Hits** (a collapsed table of the last 7 or 30 days per rule, counts as numbers, no band or colour). "Use suggested
values" fills the form and does not save. Saving sends the whole layer with a reason, like the other panels. In the queue a filter report
shows one neutral chip "Filter: Links" where a reporter would be. Simple mode and the main nav gain nothing.

## 5. Theme B: privacy requests

### 5.1 The data map

`PRIVACY_REGISTRY` (core, one entry per category, test-pinned) decides for each place a person can be found what `export` returns and what
`erase` does in each mode. Modes: `keep: 'safety'` (default) and `keep: 'none'`.

| Category (store table) | Export | Erase, `safety` | Erase, `none` |
| --- | --- | --- | --- |
| Subject and aliases (`kit_subjects`) | created time, alias count | kept only while a sanction is in force | deleted |
| Identifiers (`kit_subject_ids`) | account ids as the game gave them; counts and first/last seen of keys and addresses (hashes never leave) | kept (hashes and account ids) only while a sanction is in force; deleted otherwise | deleted |
| Sanctions and their address rows (`kit_sanctions`) | kind, rule, reason, times, ref code, source, revoked; no staff ref (`byStaff: true`) | in force: kept as stored; ended or revoked: deleted | deleted, in force included |
| Notices (`kit_notices`) | kind, rule, times, the person's own excerpt lines | in-force sanction's notice kept with its excerpt cleared; others deleted | deleted |
| Reports filed by the person (`kit_reports`) | reason, note, time, room tags | the person is removed from the row (reporter id, seat, handle, note); the report stays for its target | same |
| Reports about the person | category, reason, time, status, outcome; only lines the person wrote | deleted (decisions, AI reads, outcomes and links with them) except held | same |
| The person's lines in others' reports | none beyond the above | text replaced by a marker, writer removed from `people` | same |
| Strikes (`kit_strikes`) | the raw line, time, room | deleted | deleted |
| Mutes (`kit_mutes`) | counts of mutes placed and received (never who) | deleted | deleted |
| Blocked names (`kit_blocked_names`) | name, reason, time | deleted | deleted |
| Appeals (`kit_appeals`) | statement, status, times | deleted | deleted |
| Signals (`kit_signals`) | kind, time, count (never the source) | deleted (rows about and by the person) | deleted |
| AI marks, reads, outcomes, actions | the "do not automate" mark (code only); a count of AI reads and their outcome codes | deleted with the reports; mark deleted | same |
| Claims, Discord thread map, links | not exported (staff workflow rows) | deleted | deleted |
| Audit trail (`kit_audit`) | the actions staff took about the person: action and time, no actor | kept (ids and codes only); the person's ref is replaced by the receipt id when the identifiers are gone | same |
| Held reports (`kit_legal_holds`) | listed (id, time, code) | **kept whole**; a hold is a legal duty the kit cannot weigh | kept whole |
| Filter counters, erasure receipts | n/a (no person) | n/a | n/a |

In memory, a successful erase also removes the person from the subject index, the room roster (their seats become guests), the evidence
buffers (their lines lose text, handle and subject), the sanction index, the mute and notice caches, pacing and signal state, and the
claim and viewing hints. A line from a still-connected player after erase makes a new, unlinked subject, never a row under the old id.

### 5.2 The person and the request

A request is about one person: the canonical subject and every alias merged into it. `cw.privacy.find(who: RawWho): SubjectId | null`
finds a person by what the game knows (an account id or a client key), never creates one, and returns null for an unknown caller. There is
no player route. The adopter verifies the requester by its own means before it touches this; the kit has no way to.

```ts
// on Chatwarden (all @experimental, owner-only in the HTTP layer, never reachable from the player routes)
privacy: {
  find(who: RawWho): SubjectId | null;
  /** Everything held about the person, as one JSON-safe object (below). Async: it reads many tables. */
  export(person: SubjectId): Promise<PrivacyExport>;
  /** `dryRun` returns what a run would remove and keep and writes nothing. */
  erase(person: SubjectId, opts: { keep: 'safety' | 'none'; actor: string; dryRun?: boolean }): Promise<ErasePreview | ErasureReceipt>;
  /** What the kit keeps and for how long, from the registry and the live retention policy: for the hub and the adopter's policy text. */
  statement(): PrivacyStatement;
}
```

`PrivacyExport` is `{ format: 'chatwarden.privacy-export', version: 1, generatedAt, person: { ref, createdAt, aliases }, accounts: string[],
identifiers: { keys: n, addresses: n, firstSeen, lastSeen }, sections: { sanctions, notices, reportsFiled, reportsAbout, strikes, blockedNames, appeals,
signals, mutes: { placed: n, received: n }, ai, audit, holds }, truncated: string[] }`. Each section is capped at 5 000 rows (`truncated`
lists any that were). It never carries a hash, a raw key or address (the kit holds only keyed hashes), another player's id, handle or
lines, a reporter's identity, or a staff ref. The person's own chat text is included where the kit holds it (strikes, excerpts, notices,
statements). Reading it audits `privacy.export` (required: no audit, no export).

### 5.3 Erase

One store transaction, then in-memory fix-ups, all driven by the registry:

1. Flush queued identifier writes. 2. Resolve the person's subject set. 3. `dryRun`: count and return. 4. In one `store.transaction`:
   hold the held reports aside, apply the table rules of 5.1, insert the receipt row, rewrite the person's audit refs to the receipt id
   when nothing keeps the subject. 5. After the commit: forget the subjects in memory, then flush and run the identifier delete once more
   (a write queued between steps 1 and 4 cannot resurrect an identifier). 6. Audit `privacy.erase` (required, after the commit; a failure
   is logged and returned in the receipt's `auditFailed`, never undoes the erase).

**The safety remainder.** With `keep: 'safety'` a person with a sanction in force keeps exactly: the subject row, the identifier rows, and
the in-force sanction rows with their notice (excerpt cleared). That is what lets a ban still refuse the same player at the door. The
receipt says so (`kept.identifiers: true`) and the receipt row records the pending subject. `purge()` finishes the erase on its own:
once the person has no sanction rows left (the retention pass removed them, 90 days after they ended by default), it deletes the
identifiers and subject row and rewrites the audit refs. `keep: 'none'` deletes the sanctions too and says in the confirm that a ban
the person is under will stop applying.

**Receipt.** `ErasureReceipt { id: 'e_...', at, mode, removed: { [category]: n }, kept: { identifiers: boolean, sanctions: n, heldReports: n }, auditFailed?: true }`.
It holds no subject id and no personal data, so the adopter can send it to the requester. Receipt rows live as long as audit rows
(`auditMs`) and are purged on that clock; only the pending subject (cleared once the erase finishes) links one to a person.

**Several processes.** Another process on the same database still has the person in its memory. Erase moves the store's change token and a
persistent erasure epoch; every process re-reads the epoch at most once every 30 seconds on its next subject lookup and, when it
changed, reloads its subject index. A store write for a subject that no longer exists is a no-op (an identifier upsert is conditional on
the subject row), so a stale process cannot recreate an identifier. The window (up to 30 seconds of strikes keyed by the old id in a stale
process) is documented, and the strike and signal rows it could write are caught by the next erase sweep (`purge()` also drops
strike and signal rows whose subject no longer exists).

### 5.4 The test that makes it safe

- **Registry completeness.** A SQLite test lists every `kit_*` table from `sqlite_master` and asserts each is in the registry map (or in a
  short "holds no person" list with a reason). A new table fails the test until someone decides.
- **No id survives.** Build a person with every kind of row (including one inside another player's report and one in a held report),
  `erase` with `none`, then dump every table and assert none of the person's subject ids, aliases, account ids, handles or raw lines
  appears, except inside a held report.
- **Export holds no hash, key or address**, no other player's id, no staff ref.

## 6. Theme B: legal hold, the bundle and the event

**Hold.** `cw.legal.hold(reportId, { code, actor })`, a senior's by default (`legal.hold`, a permission), stores one row
(`kit_legal_holds`): report id, who, when, and a code from a closed list (`law_enforcement_request`, `legal_proceeding`, `platform_request`,
`safety_review`, `other`). No free text. A report can be held once; `release` is the owner's, fixed in code, not a permission.

**What a hold keeps.** The report (excerpt included), its decisions, the sanction groups decided from it (every row), their notices, the
appeals on those groups, and the AI reads, outcomes and actions for it; retention's report, sanction, notice, decision, AI and audit
purges skip them, and so does erase. Everything else about the people involved follows the normal clocks. The report body shows
`hold: { code, at }` to staff with `reports.read`; the case's `...` menu gets "Hold for legal..." (a senior) and, when held, "Release
hold..." (the owner), each a short dialog with the code list.

**The event.** `report.escalated { reportId, at, code, target: StaffRef }`, emitted after a hold commits, ids and a code only (never text);
accepted by webhooks (`events`), ignored by the Discord feed. The game finds the player through `cw.people.accountIds(target)` or the
webhook's existing `includeAccounts` opt-in. The kit forwards nothing to anyone.

**The bundle.** `cw.legal.bundle(reportId, { actor, includeAccounts? })`, owner only, audited `legal.bundle` (required). One JSON object:
`format`, `version`, `generatedAt`, `kit` (package name and version), `disclaimer` ("Generated by Chatwarden. It records what the kit
held. It does not say whether any content is unlawful and is not legal advice."), `report` (id, time, room tags, reason, note, status,
decision time), `people` (an index, a staff ref, the handle kept with the report; account ids only when `includeAccounts`), `excerpt`
(lines with `p`), `decisions`, `sanctions` (kind, rule, reason, times, staff ref, revoked), `notices` (kind and times, no text),
`appeals` (status, times, statement when still held), `audit` (action, actor, role, time, for the report and its groups), `hold`, and
`integrity`. Never a raw key, address or hash.

**Integrity.** `integrity = { algorithm: 'sha256', sha256, hmacSha256 | null, signedAt, canonicalization: 'chatwarden-json-1' }`.
`sha256` is over the canonical JSON (keys sorted, no whitespace, `JSON.stringify` strings, integers as written) of every other field;
`hmacSha256` is the same bytes under the adopter's `bundleSecret` (at least 32 characters, the same rule as a webhook secret; never read
from anywhere else). With no secret the bundle is produced unsigned and says so (`hmacSha256: null`), and the hub says "not signed".
The signature proves the file came from this kit and was not edited since; it is **not** a timestamp authority and not a notarisation, and
the doc says so. `canonicalJson` is exported (`@experimental`) so an adopter can verify.

## 7. Settings summary and what is off

Nothing here is on by default: `filters` is unset; holds and bundles exist only when a person uses them; `bundleSecret` is optional.
New retention field: `filterHitsMs` (90 days, floor 30). New permission keys: `filters.read` (moderator), `legal.hold` (senior). Fixed
to the owner in code, not permissions: erase, export, find, release hold, download a bundle (like AI acting).

## 8. Wire and API changes

- **Core.** `RefuseReason` gains `link | personal_info | filter`. `ChatServiceDeps.filters` (a per-room settings getter like `pace`) and
  `onFilterFlag`. `cw.filters.stats/test/check`, `cw.reports.fileSystem`, `cw.privacy.*`, `cw.legal.*`. `StoredReport` and `ReportRecord`
  gain `origin: 'filter' | null` and `originKey: string | null` (and `'watch'` later). `report.created` gains `origin`. New event
  `report.escalated`. `PurgeResult` gains `filterHits`, `erasuresFinished`, `strayRows`. `createChatwarden` option `bundleSecret`.
- **Store.** New required methods (first-party stores both implement them; a custom store must too): `addFilterHits`, `listFilterHits`,
  `purgeFilterHits`, `countOriginReports`, `placeHold`, `releaseHold`, `loadHold`, `listHolds`, `exportSubjects`, `eraseSubjects`,
  `insertErasure`, `loadPendingErasures`, `finishErasure`, `erasureEpoch`. `insertReport` takes the origin fields and can refuse on the
  open-filter-report index. The purge methods skip held rows.
- **HTTP.** `GET /filters/stats?days=` and `POST /filters/test`, `POST /filters/check` (`filters.read`); `POST /privacy/find { accountId }`;
  `GET /people/:ref/privacy/export`; `POST /people/:ref/privacy/erase { keep, confirm, dryRun? }`; `GET /privacy/statement`;
  `PUT /reports/:id/hold { code }`, `DELETE /reports/:id/hold`, `GET /reports/:id/bundle?accounts=`. Bodies are `no-store`; the export and
  bundle send `content-disposition: attachment`. `GET /policy/profile` gains `limits.filters.accountAge`. Staff report bodies gain
  `origin`, `originKey` and a null `reporter` for filter reports, and `hold` when held. Chat route refusals carry the three new reasons.
- **Audit.** `AUDIT_ACTIONS` appends `privacy.find`, `privacy.export`, `privacy.erase`, `legal.hold`, `legal.release`, `legal.bundle`.
  Settings changes stay `policy.update` with the section `filters`. Targets: `person` for `privacy.*`, `report` for `legal.*`.
- **Webhooks and Discord.** `report.escalated` accepted by `webhooksOut`; Discord ignores it. Nothing carries a statement, a line, a name
  or a hash.

## 9. Privacy and security

- **URL parsing safety.** No `URL` constructor, no regular expressions built from data, no recursion. One forward scan per block with a
  step budget; a test counts steps and requires that doubling a hostile input at most 2.5 times the steps, for each pathological family
  (long runs of dots, `a.a.a...`, `@@@@`, `%%%`, `[[[[`, a million-label host cut by the 2 000 character cap). A static test forbids
  `new RegExp(` in the filter modules and pins the reviewed list of regex literals (none with a nested quantifier).
- **Hostile list entries.** Domain entries and patterns are validated to the grammar above; a hostile entry is refused at save with the
  path and never echoed. Lists are bounded (100 domains, 500 patterns), so compile cost is bounded.
- **False positives on legitimate links.** An allow list is the owner's own words; `flag` is the suggested action; `count` first; the dry
  run and the 5% confirm; the TLD tiers; the shared-hosting suffix refusal; no match on `e.g.`, `v1.2.3`, scores or `file.md`.
- **Fails open on the chat path.** A throw inside the filters is caught, logged by class (`chatwarden.filter_failed`, at most once a
  minute), and the line goes on unfiltered; filters are a safeguard, not access control (the `gate` hook fails closed, filters do not).
- **Logs** carry event names and error classes only, never a line, a domain, a pattern, an id or a count of people.
- **A filter hit is not a record.** No counter is keyed by person, and a line a filter refused is not kept (no buffer, no strike, no notice).
  A `flag` report keeps the excerpt like any report, on the report clock.
- **Erase and export are owner-only and not on any player route**; a test lists every player route and asserts none touches `cw.privacy`.
- **Bundle secret** is never logged, never in a body, never echoed in an error.

## 10. Edge cases

| Case | Behaviour |
| --- | --- |
| `https://google.com@evil.com/x` | host `evil.com`; not on allow list, so `unlisted` |
| `evil.com` in a sentence, no scheme | link (strong TLD); `ok.so`, `this.is` are not; `t.me/abc` is |
| `1.2.3`, `3.14`, `v1.2`, `e.g.`, `readme.md`, `file.zip` | not links |
| `192.168.0.5:7777` | link, detail `unlisted` (IP); allowed only if the exact IP is on `allow` |
| `evil[.]com`, `evil(dot)com`, `evil。com`, `hxxps://evil.com` | read as `evil.com` |
| `аррӏе.com` (Cyrillic) | `unlisted`, even with `unlisted: 'allow'` |
| An allowed domain's subdomain | allowed; `cdn.example.com` for `example.com`; `=example.com` is exact |
| `allow: ['github.io']` | refused at save: shared hosting; write `=name.github.io` |
| A line that is only a link, masked | delivered as `****`; the author sees it |
| Email `a@b.com` | personal info, never a link |
| `1500 2000 3000`, `100 200 300 400` | not a phone under `formatted`; a phone under `any` (the documented false positive) |
| `discord is down`, `my snap is john_doe99` | the first is not contact info, the second is |
| A refused line from a guest | refused and counted; a `flag` from a guest counts only |
| A speaker flagged twice in one room | one open report; the second counts |
| Flag cap reached | `flag` counts only (`flag_capped`), the line still delivers |
| Two rules refuse one line | the first in the fixed order is cited; both count |
| `mask` and profanity `star` on one line | filter spans first, profanity on the masked text |
| `ignore` phrase inside a link | the ignored part is blanked, the rest still reads |
| Erase a person in two alias subjects | both erased; the receipt counts them as one person |
| Erase with an open appeal and an open report about them | both deleted; the claim on the case released |
| Erase while a report about them is held | the held report and everything on it stay whole; the receipt says `heldReports: 1` |
| Erase a person already erased | `{ ok: true, removed: {} }`, no second receipt for an unknown person (`not_found`) |
| Export for a person with 6 000 strikes | first 5 000, `truncated: ['strikes']` |
| Hold on a report already purged | `not_found`; hold before the purge only |
| Release a hold | the report purges on the next pass if past retention; one audit row |
| Bundle with no `bundleSecret` | produced, `hmacSha256: null`, the hub says "not signed" |

## 11. Tests that pin it

Broad, test-first, fake clock; targeted runs only. The ones no happy path would write:
- **Filters.** Pathological-input step-count tests per scanner; a link corpus (about 80 must-match and 80 must-not-match lines, synthetic
  domains such as `zorbak-gold.example`, `vlemmo.test`); phone/card/contact must-match and must-not-match lines including scores, levels and
  coordinates; phrase folding (`g0ld`, `g.o.l.d`, `goooold`, accents, full width); the allow/deny/unlisted/new-account matrix; off means
  identical (every `ChatResult` and event equals the version without `filters`); a refused line writes nothing anywhere; the daily flag cap
  across two `cw` instances on one store; a throwing filter and a throwing account-age hook fail open.
- **Reports.** A filter report has no reporter effect anywhere (every reader of `reporterSubject` is listed in the task and tested).
- **Privacy.** Registry completeness (SQLite); no id survives (both stores, the same script); alias erase; erase racing a queued identifier
  write; two processes and the epoch reload; a safety remainder and the later automatic finish; erase under a hold; export holds no hash.
- **Legal.** Hold survives a purge of every kind of row it protects and is released by the owner only; a canonical-JSON golden file with a
  fixed key and clock; tamper tests (one changed byte fails verification); the bundle holds no hash, key, address or other player's id.
- **HTTP and UI.** Permission boundaries; audit modes (export, erase and bundle are `required`); no player route reaches `cw.privacy`;
  the hub panel, lazy, axe, 360 px, light and dark; the first-load budget holds.

## 12. What the kit must NOT do

- **Judge legality.** It does not say a line is a crime, a threat is credible, a request is valid, a safety exception applies or a retention
  period is lawful. The adopter decides. The `safety` remainder is a mechanism with a stated meaning (enforce a sanction in force and honour a
  hold), not a legal conclusion; the in-product words and every template say "not legal advice" and claim no compliance.
- **Report to anyone.** No law enforcement, NCMEC or regulator contact, ever, and no message to the player about a request or an erase.
- **Verify identity or authority** of a requester or an authority asking for a bundle.
- **Fetch, resolve, preview or look up a URL**, or send a link to a third party. No URL reputation service.
- **Run a model or a score in the filters**, or let a filter or a signal write a sanction, a strike or a timeout.
- **Store the refused text**, or key any filter counter by person.
- **Hide a restriction**: a refused or masked author always sees it.
- **Hold more than it needs**: the bundle carries no hash, key or address, and an export no other player's data.

## 13. Breaking changes (0.2.0, no shims)

1. `RefuseReason` gains `link`, `personal_info`, `filter`; an exhaustive switch (the chat box, `RestrictedChatLine`, adopters) must handle them.
2. `Store` gains required methods (the optional-method pattern exists for third-party stores that no longer matter): a custom store must implement them, and `cw.privacy` is never "unsupported". `insertReport` and the report row types gain origin fields.
3. `ReportRecord.reporterSubject` is no longer always a subject id: for a filter report it is `filter:<id>`. `isSystemReport` reads `origin` instead of an empty reporter; every reader of the reporter fields is audited in F5.
4. The SQLite and in-memory stores drop the "run a database step yourself" erase guidance; the SQLite README is rewritten around `cw.privacy`.
5. `PurgeResult` and `RetentionPolicy` gain fields; `purge()` finishes pending erasures and drops stray rows.
6. `AUDIT_ACTIONS` and `KIT_EVENT_TYPES` append; the `report.created` event gains `origin`.
7. `PERMISSION_KEYS` gains `filters.read` and `legal.hold`.
8. SQLite migration 26 (shared by the whole release; section 15) is one-way.

## 14. Interfaces needed from the other themes

- **Names in reports and the "what the player sees" preview.** Every place that renders a reporter must accept `reporter: null` with an
  `origin` chip (the case card, the queue row, the Discord post, the AI read's brief). The preview should list the three new refusal
  words (keys in 4.10) as lines a player can be shown. A filter report's target handle goes through their handle masking like any other.
- **Urgent lane, desk, rooms.** (a) `report.escalated` is mine and means a legal hold; their "ask a senior" must use another name.
  (b) The case `...` menu needs an extension list so "Hold for legal..." and "Release hold..." are items, not a rewrite of their menu.
  (c) A room lock or emergency mode that wants "links off" should not edit the profile: it supplies a per-room `ResolvedFilters`
  (the getter in 4.1) that overlays `links` with `unlisted: 'act'`; I provide `overlayFilters(base, patch)`.
  (d) A filter `flag` report is never `urgent` unless the owner marks its reason urgent in their reason list; their sort must treat
  `origin` reports like any other.
- **Any server, many rooms, languages.** (a) Service mode's check route returns refusals as `{ reason, rule }`; the three new reasons are
  strings in that contract. (b) `profile.contexts` merges the `filters` section with the same merge rule as `pace`; I export `mergeFilters`.
  (c) Phrase rules carry no language; a language pack adds `FILTER_SUGGESTIONS` templates and word keys only. (d) The pacing-style
  per-process caveat does not apply to filters (no state) except the 30-second counter flush; `flagCapPerDay` is counted from the store.
  (e) A shared store across processes is exactly the case section 5.3 handles.
- **The controller.** One migration, 26. The pieces this note adds are listed in the plan header (section "Migration 26").

## 15. Rulings

*(Taken by the designer where the owner had not spoken; to be confirmed by the controller.)*

1. **Actions are `count`, `flag`, `mask`, `refuse`** (the audit's `note` is renamed: `note` is also a sanction kind and a person note).
2. **Presets ship `filters` unset**; `FILTER_SUGGESTIONS` is a hub button. The audit's "strict profiles turn the packs on" is dropped to honour "everything off by default".
3. **Filters are edited through the policy layer only** (`policy.write`, the owner), not a new `filters.write`; `filters.read` is a moderator's.
4. **Refusal words are three** (`link`, `personal_info`, `filter`); phrase and ratio share `filter`.
5. **No owner regular expressions**; a fixed pattern vocabulary (words, alternation, prefix, `*`, `~`).
6. **Own text folding in core** (core cannot import the matcher); leet mapping only inside a chunk that holds a letter.
7. **TLD tiers** (strong bare, weak only with a path) and a shared-hosting suffix refusal on the allow list.
8. **A non-ASCII host is always `unlisted`** even under `unlisted: 'allow'`.
9. **`ignore` is its own list**, not the term exceptions (those are about slurs, in the term store, with their own audit).
10. **The dry run uses the adopter's `recentLines()`**; no new line store. `count` is the real-traffic dry run.
11. **A filter refusal is not buffered and not stored**; a `flag` is buffered like a delivered line.
12. **A flag is a system report** with `origin`, reporter `filter:<id>`, one open per person and room, a daily cap counted from the store. No `kit_reports` rebuild (additive columns and a partial unique index).
13. **Hit counters are in memory with a 30-second flush**, keyed by day, key and action, never by person; retention 90 days (floor 30).
14. **`address` can only count or flag.**
15. **Erase keeps a minimal remainder, `safety` by default**: subject and identifier rows plus sanctions in force, until the retention pass removes the sanction; then the erase finishes itself. `none` deletes everything but held reports.
16. **Erase removes a reporter's identity but keeps the report for its target**; reports about the person are deleted (held ones excepted); the person's lines inside other reports become a marker.
17. **The audit trail is kept**, with the person's refs rewritten to the receipt id once nothing keeps the subject (the only rewrite of audit rows the kit ever does).
18. **A receipt holds no personal data** and is purged on the audit clock.
19. **Export omits hashes, other players, reporters and staff refs**; mutes are counts only.
20. **A hold is on a report**, with a closed code and no text; senior places, owner releases; erase and every purge respect it.
21. **Erase, export, find, release and bundle are fixed to the owner in code**; only `legal.hold` and `filters.read` are permissions.
22. **The bundle is signed with an HMAC under `bundleSecret`**, unsigned (and labelled) without one; it is not a timestamp.
23. **Stale processes** are handled by an erasure epoch re-read every 30 seconds and conditional identifier writes; the window is documented.
24. **Required `Store` methods** for everything new (section 13).
25. **Static import of the filter engine**; its size is budgeted in F4 and, only if the browser bundle budget is exceeded, split behind an `import()` loaded when `filters` is first set (the signals precedent).
