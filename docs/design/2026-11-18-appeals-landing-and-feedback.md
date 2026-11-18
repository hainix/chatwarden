# Appeals outside the game, and appeals that teach the system

Status: approved by the owner 2026-11-18 ("all of your recommendations are good"; fixed reasons only). Release: 0.2.1 (additive).
Builds on `docs/design/2026-11-12-appeals-and-names.md` (the in-game appeal of 0.1.9), which stays the contract for filing and deciding.

## 1. Why

In most online services, a person who has an action placed on them gets an email that says what happened and links to an appeal page.
A person who tries to come back while banned is sent to that same page instead of into the product. The page lets them appeal
without giving them access to their account. Chatwarden 0.2.0 can only take an appeal from inside the game: a notice, or My record.
A banned player never reaches either, so the person most likely to appeal has nowhere to do it, and games fall back on a Discord link or an
email address (Moxgate does today). Nothing filed that way can be tied to a sanction, rate limited, kept from the moderator who decided it,
or learned from.

The second gap is the feedback. A granted appeal (lighter or lifted) tells the AI's casebook it was wrong, and nothing else. When the
sanction came from the kit's own term filter (an automatic chat restriction), the strike that caused it still counts toward the next,
longer restriction. The term that matched gets no signal, and the chat filters (links, personal information, phrases) don't either. The
system that made the mistake should hear about it, and a person should decide what to change.

Owner, 2026-11-18: "Chat Warden should provide the hooks for that, so we can handle appeals appropriately as like a holistic system. And
then the appeals themselves can land on a manual desk for now for someone to grant, and then we should figure out what to do with them."

## 2. Goals, non-goals, anti-goals

### Goals
- **Delivery hook.** When a sanction notice is created (and when an appeal is decided), the kit hands the game everything it needs to
  email the person: who it is about (the game's own ids), the words in the person's language (subject, plain text, HTML), and an appeal
  link when the sanction is appealable. The game sends the email. The kit never stores an email address and never contacts a player.
- **Appeal links.** `cw.appeals.link(noticeId)` makes a signed, expiring link to the landing page for one sanction. The game puts it in
  the email, on its ban screen, and on any door the person is turned away from. A door refusal carries the link itself.
- **A landing page outside the core flow.** It is served by the kit's player routes at a path of its own, needs no game login, and gives
  no account access. It shows only the one sanction the link names: what it was for, how long it lasts, and what the person was shown.
  It takes one appeal statement, and later shows the status and the outcome with its reason. A React `AppealPage` gives the same page
  to a game that hosts it on its own domain.
- **The manual desk.** Appeals land in the existing Cases queue appeals view (0.1.9), decided by a person who did not make the original
  decision. The decider picks one fixed reason the person is shown with the outcome.
- **Feedback to what caused it.** A granted appeal is passed back to whatever produced the sanction:
  - **A report, decided by a moderator or the AI:** what 0.1.9 does already. The decision is marked reversed, a corrective example is
    added, and it counts toward the per-rule false-positive rate.
  - **An automatic restriction from the term filter:** its strikes and its start no longer count toward the next restriction. The term
    that matched gets an "overturned on appeal" count, and the slur list shows a review flag. The term is never changed automatically.
  - **A report filed by a chat filter:** that filter gets an overturned count, shown next to its hits.
  - **The person who reported:** counts as neither right nor wrong in their report record. They acted in good faith.
- **"What caused this" on the desk:** the source of the sanction (the term, masked until shown, the filter, the AI read, or the original
  decision), with a link to that source's settings, behind the advanced view.
- **Service mode:** the same as `/v1` routes and a signed delivery webhook, so a game whose server is not Node gets all of it.

### Non-goals
- Sending email, or storing an email address. The game sends; the kit hands over the words and the link.
- An appeal by a reporter against a dismissed report, and an appeal of a note. Both are unchanged from 0.1.9.
- A free-text reply from the decider. Owner: fixed reasons only, "just to keep things simple".
- Any automatic change to a term, a filter or an AI setting because of appeals. The kit flags; a person changes.
- Automating the appeal decision, including AI triage of appeals. The owner wants them on a manual desk "for now"; what to do with them
  next is a later design. This one keeps the data that design will need (sources, reasons, outcomes, times).
- A delivery outbox or retry queue in the store. The hook is told once after the commit; service mode retries in memory (6.4).

### Anti-goals (this would be a failure even if it works)
- The landing page leaks anything beyond the one sanction: another notice, the account, the reporter, staff names, private reasons, or
  whether some other id exists.
- The link works as a login, or lets someone act as the person anywhere else.
- A banned person sees an error page or the game's front door instead of the appeal page.
- An overturned automatic restriction still makes the person's next restriction longer.

## 3. Rulings

1. **The link is a capability for one sanction, not a session.** It is `<landingUrl>?t=<token>`, where the token is
   `base64url(payload) + '.' + base64url(HMAC-SHA256(secret, 'chatwarden.appeal.v1.' + payload))`. The payload is
   `{ v: 1, n: noticeId, e: expiresAtMs }`, with no subject id and no personal data. The kit's existing `secret` is the key, and the
   message is namespaced so an appeal token can never verify as any other kit signature. The token is checked with constant-time
   comparison. A token whose notice is gone (erased, purged or withdrawn) answers the same "this link is no longer valid" as an expired
   or forged one, so ids can't be probed.
2. **A link lasts 30 days by default** (`appeals.linkTtlMs`, from 1 hour to 365 days), and never longer than the sanction stays appealable
   (the 0.1.9 rule). A game can mint a fresh link at any time, and the door refusal mints one on every refusal, so a person turned away
   always gets a working link.
3. **The landing page lives at its own path and uses no identify hook.** Player routes serve `GET /appeal`, the page, and `GET` and
   `POST /appeal/case`, its JSON. All of them read only the token. None calls the game's `identify`, and none sets a cookie. The page
   answers with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, a strict CSP (no third-party anything),
   and `X-Frame-Options: DENY`. Because the token sits in the URL, the docs tell operators to keep query strings out of access logs.
   A game that hosts the page elsewhere sets `appeals.landingUrl` to its own address and lists that origin in
   `appeals.landingOrigins` for CORS on `/appeal/case`.
4. **The served page works without JavaScript.** It is server-rendered HTML with a plain form that POSTs. That way it opens in any mail
   client's browser and loads nothing from a CDN. It is styled by one inline stylesheet that respects `prefers-color-scheme`, is
   readable at 360 px, and is in the person's language (the notice catalogues: English, Spanish, Portuguese, or the game's own words
   through `appeals.words`). `AppealPage` in player-react does the same against `/appeal/case`.
5. **The delivery hook is told after the commit, fenced, once.** It is an option, `notices.deliver(delivery)`, called when a notice of a
   sanction kind is created, and again when an appeal outcome notice is created. A throw or a rejection is logged by class and never
   fails the sanction. `delivery` carries the game's ids for the person (`accountId`, `clientKey`, whichever the kit holds) and never an
   IP hash. Like `sanction.applied`, it carries subject ids, so the docs say it belongs on the game's server only.
6. **Fixed reasons.** Every decision takes one `reason` from a fixed set per outcome (section 5.2). The decider's private reason (0.1.9)
   stays and is never shown to the person.
7. **"Overturned" means a granted appeal**, lighter or lifted, and nothing else. A moderator lifting a sanction outside an appeal stays as
   it is today: "a moderator lifting a timeout does not undo the behaviour" (strikes.ts).
8. **Store migration 27** holds the new columns. It is the first migration after the 0.2.0 schema, and is one-way like the rest.

## 4. The person's side

### 4.1 Links

```ts
// on cw.appeals
/** A signed link to the landing page for one sanction notice, or null: appeals off, no landingUrl, not a sanction notice, or not appealable now. */
link(noticeId: string, opts?: { ttlMs?: number }): string | null;
/** Check a token; the landing routes use this. Never throws. */
openLink(token: string): { ok: true; noticeId: string; expiresAt: number } | { ok: false; reason: 'invalid' };
```

`DoorRefusal` gains `appealUrl?: string`, set when the refused sanction's notice is appealable and a link can be made. `PlayerNotice`
(from `cw.notices.pending` and `record`) gains `appealUrl?: string` on the same terms, so a game can show it beside the in-game dialog.
The service mode's doors and notices answers carry the same field.

### 4.2 The landing page

`GET /appeal?t=` renders one of these, in the person's language. The language comes from `?lang=`, then `Accept-Language`, then
English.
- **Invalid or expired link:** one sentence, plus the game's support line if `appeals.contact` is set. Nothing else.
- **The sanction, no appeal yet:** the notice title and body (from the notice copy, the same words as in the game), the Community Rule
  with its name and number, the end time or "permanent", and what the person was shown (their own lines, masked as on the notice). Then
  the statement form, which follows the 0.1.9 rules: up to 1000 characters, refused rather than cut, and rate limited per person per
  week. A short line explains that a different moderator will review it and that the decision is final.
- **Appeal sent:** the date, and the line "We will email you when it is decided" if the game says it emails (`appeals.emailsOutcome`,
  default false). Otherwise: "Come back to this page to see the outcome."
- **Decided:** the outcome in words (kept, lighter, lifted), the fixed reason sentence, and the sanction as it stands now.

`POST /appeal/case` (JSON, for `AppealPage`) and the form POST both call `cw.appeals.file` with the notice the token names. A form POST
answers with a redirect back to `GET /appeal?t=` (POST-redirect-GET). `GET /appeal/case?t=` returns the page's data as JSON. Its shape is
`AppealCase`, which holds only what the page shows: no staff field, no sanction or person id, and no private reason.

The routes are rate limited per IP and per token, and a refusal answers in the page's words. The 0.1.9 refusals map one to one:
`already_appealed` shows the appeal's status, and `rate` shows when to try again.

### 4.3 Delivery

```ts
export interface NoticeDelivery {
  kind: 'sanction' | 'appeal_outcome';
  noticeId: string;
  /** The game's own ids for the person, whichever the kit holds. Never an IP hash. */
  to: { accountId: string | null; clientKey: string | null };
  locale: string;              // from notices.localeOf(to) when given, else 'en'
  subject: string;             // e.g. "Your chat has been restricted for 24 hours"
  text: string;                // plain text body, the link included
  html: string;                // a small self-contained HTML body, the same content, escaped
  appealUrl: string | null;    // null when not appealable, appeals off, or no landingUrl
  sanction: { kind: SanctionKind; until: number | null; rule: RuleRef | null };
  outcome?: { status: 'upheld' | 'reduced' | 'revoked'; reason: AppealReasonCode };
}
// createChatwarden options
notices?: { deliver?: (d: NoticeDelivery) => void | Promise<void>; localeOf?: (to: NoticeDelivery['to']) => string | undefined };
```

The words come from the notice copy plus a small set of new delivery keys (subject lines, "Appeal this decision", the footer). They are
translated in es and pt like the rest. A recipe, `docs/recipes/appeal-emails.md`, shows the hook sending through a generic mail function
and lists what a good appeal email says.

## 5. The desk

### 5.1 What caused this
`StaffAppeal` gains `cause`:

```ts
cause:
  | { source: 'report'; reportId: string; decidedBy: 'human' | 'ai' }
  | { source: 'term'; termId: string | null; strikes: number }   // automatic restriction; termId null for an older row
  | { source: 'filter'; reportId: string; filterKey: string }
  | { source: 'other'; via: 'coop' | 'api' }
```

The hub shows it in Detailed, behind the advanced view (the clean-core rule). For a term, it shows the term masked until "Show", with a
link to that term in the slur list. For a filter, it links to the filter settings. For a report, it links to the original report and,
for the AI, to the AI read.

### 5.2 Fixed reasons
`AppealReasonCode`, required on every decision, one of:
- **upheld:** `rule_applies` ("The rule applies to what was said."), `evidence_clear` ("The chat record shows the rule was broken."),
  `context_considered` ("We looked at the whole conversation, and the decision stands.")
- **reduced:** `first_offence` ("We lightened it because this was a first offence."), `lighter_fits` ("A lighter action fits what
  happened."), `context_considered` ("We looked at the whole conversation and lightened it.")
- **revoked:** `mistake` ("This was our mistake. We are sorry."), `not_a_violation` ("What was said does not break the rules."),
  `context_considered` ("We looked at the whole conversation and lifted it.")

A reason that doesn't belong to its outcome is refused with `invalid_reason`. The words are in the notice copy (en, es, pt) and can be
overridden through the game's catalogue. The hub shows the three choices as a radio group in the decision bar, with the first one
preselected.

## 6. Feedback

### 6.1 Automatic restrictions from the term filter
When an appeal is granted on a sanction with `source: 'auto_filter'`:
- The sanction group is marked `overturned_at`. The strikes that tipped it are marked `overturned` too: the person's strikes in the
  strike window before the group's start, which are exactly the ones `record` counted. `StrikeService` drops them from its tally and drops
  the group's start from `lastAutoStart`. It does this live, and on `load()` after a restart. The person's next restriction is then
  computed as if the overturned one had never happened.
- Each overturned strike keeps its `term_id`. `cw.terms.reviewFlags({ days = 90, min = 2 })` returns
  `{ termId, overturned, lastAt }[]` for terms overturned at least `min` times in the window. The slur list shows a flag on those terms
  ("Overturned on appeal 3 times in 90 days"), with the term's dry run one click away. Nothing changes the term.

### 6.2 Reports filed by a chat filter
For a granted appeal whose sanction came from a report with `origin: 'filter'`, the filter key gets an overturned count over the same
window. The filter settings show it next to the filter's hits. The count is computed on read from the appeals and reports tables; there
is no new counter table.

### 6.3 Reports decided by a person or the AI
This is unchanged from 0.1.9 (`onGranted`, `markReversed`, the corrective example, the per-rule false-positive rate). It now also runs
for sanctions with `source: 'ai'` (level 3 acting), so the level 3 and level 4 gates read it.

### 6.4 The reporter
In the reporter-accuracy count, a report whose resulting sanction was overturned on appeal counts as neither upheld nor dismissed. It
never counts toward bad faith.

### 6.5 Service mode
New service routes:
- `POST /v1/appeals/link` with `{ noticeId }`, which returns `{ url | null }`.
- `POST /v1/appeals`, which files an appeal for a game with its own UI. It uses the same `who` as the other routes.
- `POST /v1/appeals/mine`.

The doors and notices answers carry `appealUrl`.

Delivery for service mode is `CHATWARDEN_DELIVERY_URL`. `NoticeDelivery` is POSTed there as JSON, with an
`X-Chatwarden-Signature: sha256=<hmac>` header over the body, keyed by a separate `CHATWARDEN_DELIVERY_SECRET`. A failure is retried
in memory, 3 times over 10 minutes. It is logged by class, never with the body. `chatwarden serve` serves the landing page itself.

## 7. Settings, store, events

- **Settings:** `appeals.landingUrl` (when unset, the kit-served page under the player routes' mount, when the routes know it),
  `landingOrigins`, `linkTtlMs`, `contact`, `emailsOutcome`, `words`. All but `landingUrl` and `landingOrigins` are live in the hub's
  Appeals settings. Those two are code- or env-only, because they decide where links point.
- **Migration 27:**
  - `kit_appeals.reason_code`
  - `kit_sanctions.overturned_at`
  - `kit_strikes.overturned`
  - an index for term review flags, `(term_id, at) WHERE overturned = 1`

  Memory store parity. Privacy registry: no new table. The new columns sit in person-keyed tables that are already registered. Export
  includes `reason_code`, and erase removes the rows as today.
- **Events:**
  - `appeal.decided` gains `reason`.
  - A new staff event, `sanction.overturned`, with `groupId`, `source`, `termId?` and `filterKey?`, for webhooks and the Discord feed
    ("Overturned on appeal: an automatic restriction from the slur list").
  - The delivery hook is not an event: events are staff channels.

## 8. What is left to the builder
- How the served page's HTML is put together: a small template module. Its strings come from the catalogues.
- The exact rate-limit numbers for the landing routes. Use the player routes' defaults, and keep them per IP and per token.
- The hub layout of the review flags and the overturned counts, within the clean-core rule and the existing components.
- Test names, file splits and the order of work inside each task.

## 9. Moxgate (after 0.2.1 publishes; LOCAL main only)
- Turn appeals on. Set `landingUrl` to the relay's player route.
- Replace the Discord invite.
- Wire the door refusal's `appealUrl` into the banned screen.
- Hook `notices.deliver` to email the account's address, only if Moxgate has a mail sender. If it has none, ship the hook as an
  in-game notice only, and note the email as an owner follow-up.
- The production flip stays the owner's.

## 10. Builder-check rulings (2026-11-18, the controller's calls; none changes what the owner approved)

1. **Delivery fires only when an `accountId` is known.** The kit holds client keys only as hashes, and an email belongs to an account. `to`
   becomes `{ accountId: string }`, the most recently seen account alias of the person. With no account, the hook is not called and
   `chatwarden.delivery_skipped_no_account` is counted (no id logged). `NoticeDelivery.sanction` gains `source` and `automated`, so a
   game can choose not to email, say, a one-hour automatic restriction.
2. **Which creations deliver.** Every sanction notice created with `notify: true` delivers: moderator decisions, direct sanctions,
   automatic restrictions, coop, api, warnings. A reduce's replacement notice (`notify: false`) does not. The `appeal_outcome` delivery
   carries the sanction as it stands after the decision, so a reduce sends one email, not two.
3. **`landingUrl` is required for links.** Core can't know where the player routes are mounted. With `landingUrl` unset, `link()`
   returns null and no `appealUrl` appears anywhere. `chatwarden serve` sets it from `CHATWARDEN_PUBLIC_URL` + `/appeal`. The http
   README shows the one line for library mode.
4. **Capability filing.** Core gains `cw.appeals.caseByLink(token)` and `cw.appeals.fileByLink(token, { statement })`. They verify the
   token in core, load the notice by id alone, derive the person (and aliases) from the notice row, and then run the same checks as
   `file`, in the same order, with the weekly cap per that person. The landing routes call only these. `/v1/appeals` and
   `/v1/appeals/mine` use the existing `who`.
5. **Reporter count.** Migration 27 adds `kit_reports.overturned_at`, set when a granted appeal's sanction came from that report. In
   `reporterOutcomes`, a report counts as upheld only when it is `actioned` and not overturned. The covering index is rebuilt to include
   the new column, so the read stays index-only. `ReporterAccuracy` gains `overturned` (additive). Each feature keeps its own window:
   30 days for reporter accuracy, 90 for term flags and filter counts.
6. **Overturn records outlive strikes.** Migration 27 adds `kit_sanctions.term_id`: the term of the strike that tipped an automatic
   restriction, written when it is applied, so the cause is known for the sanction's whole life. It also adds a table, `kit_overturns`
   (`group_id` PK, `at`, `subject_id`, `source`, `term_id`, `filter_key`, `report_id`). It is person-keyed, so it goes in the privacy
   registry, with export and erase in both stores. It is purged on the appeals retention. Term flags and filter counts read
   `kit_overturns`, never strikes. `kit_strikes.overturned` stays, and only keeps overturned strikes out of the tally on `load()`.
7. **One term per overturn.** The cause's term is the tipping term (`kit_sanctions.term_id`), and a term flag counts overturns, one per
   group. Live, `StrikeService.forgive(subject, startsAt)` drops the in-memory strikes in that window. It then re-reads the person's
   latest automatic start that isn't overturned, through a new optional store method, `latestAutoChatStart(subject)`. Contract tests
   cover it in both stores.
8. **A filter report decided by a person feeds both.** `cause` becomes `{ source: 'filter'; reportId; filterKey; decidedBy }`. The 6.3
   path (reversed, corrective example, per-rule rate) runs for every overturn that has a report. If an AI-acted sanction carries no
   `reportId` today, the builder links it to its report when the AI acts, so 6.3 reaches it.
9. **`reasonCode` is optional in the APIs for 0.2.1, so the release stays additive.** A missing code is stored as `context_considered`,
   which is neutral for every outcome. A code that doesn't belong to its outcome is refused as `invalid_reason`. The free-text `reason`
   stays required and private. The hub always sends a code.
10. **The token alone protects the landing POST.** It is a capability, and the page sets no cookie, so there is nothing for cross-site
    request forgery to exploit. The routes parse urlencoded form posts, answer the form with a 303, and answer CORS preflight for listed
    origins only.
