---
status: approved
updated: 2026-11-09
phases:
  - name: "K0: repos, licences, CI, framing"
    status: open
  - name: "K1: core + SQLite store + matcher (extracted from Moxgate)"
    status: open
  - name: "K2: Community Rules, Warning, ladder, player notices (11-09 spec B + C)"
    status: open
  - name: "K3: AI read (optional) + Discord feed (11-09 spec A)"
    status: open
  - name: "K4: React UI: moderator hub + player components"
    status: open
  - name: "K4b: init CLI, service mode (Docker/HTTP for stacks that aren't Node), agent docs, Claude Code plugin, agent eval"
    status: open
  - name: "K5: Coop adapter (review in Coop's console) + AI read as a Coop signal"
    status: open
  - name: "K6: Moxgate adopts the kit"
    status: open
  - name: "K7: community term corpus (own corpus service on Cloudflare, Zenodo mirror)"
    status: open
  - name: "K8: landing page + docs site (Cloudflare Pages, own domain)"
    status: open
---

# An open-source moderation kit for small platforms

Date: 2026-11-09. Status: APPROVED by the owner 2026-11-09 ("looks good on all of these, let's go"); every recommendation below is the decision. Working name **`chatwarden`** (owner question 1).

Reads with:
- `2026-11-09-open-moderation-brainstorm.md` (why a kit, why Coop is a partner and not the host)
- `2026-11-09-mod-triage-actions-notices-design.md` (the feature spec this kit now carries)
- `docs/research/2026-11-09-community-term-corpus.md` (the shared slur list)
- `docs/research/2026-11-09-moderation-industry-survey.md` (what the industry does)

## Why

Small platforms (indie games, community apps, small fediverse servers) get no off-the-shelf moderation they
can run.
- **Perspective** is shutting down.
- **Paid vendors** only detect bad messages; they don't run reports, reviews or sanctions.
- **Coop** is a strong review console. But it needs about 8 backing services, and ROOST says outright that it
  does not build the player-facing half: report buttons, notices and enforcement.

Moxgate built that half and runs it in production: evidence the server witnessed, fair reporting with
bad-faith tracking, sanctions that follow a person across linked accounts and browsers, player notices, a
precision-first slur matcher, and a Discord review feed. The owner (2026-11-09):

> "If we're building them to open source them, let's build them properly... in our own package... build the
> UI as an adapter to existing ROOST things... then adopt the Moxgate ones... free and off the shelf with no
> real support. We could take PRs... a corpus that we start and other people can contribute to, like a
> group project."

So the features in the 11-09 spec get built **in the kit first**, properly, with good UI. Moxgate becomes its
first adopter.

Owner, later the same day:

> "We'll make a landing page, GitHub repo, everything. Do it right, like if we were doing this from scratch and
> then adopting it full featured ourselves. Bringing AI moderation into it is probably the killer feature."

So the kit is a **product built from scratch**:
- **Moxgate is the reference, not the source.** Its code shows what works and its tests list the cases to
  cover. The kit is written fresh to the kit's own API, test-first, and Moxgate then adopts it with every
  feature turned on.
- **AI moderation is the headline**: a solo developer with no moderation team gets a team's worth of
  judgement, and stays in control.

## Goals

1. A platform with a chat (game table, room, channel, DM) can add the full loop in a few days:
   1. capture evidence
   2. take a report
   3. review it
   4. act on it
   5. tell the player why
   6. let the player see the rules
2. **Two review backends, same player side.** Use the kit's own small hub (SQLite, one process), or send
   reports to **Coop** and review them in Coop's Review Console. The Coop adapter turns Coop's decisions
   into kit sanctions and notices.
3. Everything AI is **optional**, off by default, and works with any provider.
4. **Discord hooks** are built in: a review feed with one forum thread per reported player, outcomes, and the
   AI severity tag. No chat text by default.
5. A **community term corpus**: a group-maintained, precision-first slur list. Every term ships with lines it
   must block and lines it must never block, and CI enforces both.
6. Moxgate runs entirely on the kit, with no behaviour change for players beyond the 11-09 spec.

## Non-goals

- Hosting anything. The kit is libraries plus UI; adopters run it.
- Support promises. "Reference, as-is, no SLA." PRs welcome; maintainers review when they can.
- Child-safety detection, CSAM hashing, legal reporting. The README's first line points to Coop and HMA for
  those.
- Voice and images. Live chat is covered only by AI level 4 (Watch): asynchronous and opt-in, it files
  reports and never blocks or delays a message.
- Replacing Coop. Where an adopter outgrows the built-in hub, the answer is the Coop adapter.

## Anti-goals

- A kit that only fits Moxgate. Every package must have a second, non-Moxgate example (the `examples/` app)
  exercising it.
- Shipping slur data in the default install.
- A framework lock-in: the core is plain TypeScript with no web framework, no ORM and no UI dependency.
- An AI feature that is on by default or sends identifiers to a model.
- Copy that impersonates or implies endorsement by ROOST, Coop or Discord. We say "works with Coop" only.

## Shape

### Repo (owner question 2)

One repo, `hainix/chatwarden`: Apache-2.0, DCO sign-off. It holds:
- the packages, UI, examples and CLI
- the landing page and docs site (`site/`)
- the corpus service's code (`services/corpus/`) and the corpus tooling (schema, gates, release scripts,
  synthetic tests)

It holds **no terms**. With the terms off GitHub, a separate terms repo has no job left.

**Where the terms themselves live (owner 2026-11-09: not GitHub, no asking GitHub for exceptions).**
GitHub, Codeberg and Hugging Face all prohibit hateful content in their terms. Codeberg also bans mostly
AI-generated projects since July 2026. A slur list is moderation data, but we don't want its survival to
depend on a reviewer's reading of that. So the data never sits in a public code repo:

1. **Canonical home: the corpus service, our own.** It runs on the owner's Cloudflare account: a Worker + D1
   for terms and submissions, and R2 for release files.
   - **Releases.** Versioned, signed releases (`terms-2026.12.0.zip` + a manifest with sha256 and an ed25519
     signature).
   - **Zipped with a public password.** The security-research convention for malware samples: the password is
     printed in the docs. It keeps automated scanners, search indexing and casual browsing from surfacing raw
     slurs, while anyone can open it.
   - **Licence.** CC BY 4.0.
2. **Contributions come from where moderation happens.**
   - The hub's term editor has a **"Share with the community list"** button. It sends the term, its language,
     and its must-block and must-never-block lines to the corpus service's submission API. It is opt-in per
     installation and signed with the installation's key.
   - The submission runs the gates on arrival: the cross-language negative-corpus check against every
     released term and line, format, and duplicates.
   - Language reviewers (two humans, one fluent) review submissions in **the kit's own hub**, pointed at the
     corpus service. This dogfoods the review UI.
   - A monthly script cuts the next release from accepted rows.
   - People without an installation submit through a web form on the docs site.
3. **Mirrors so it outlives us.** Each release is also archived to **Zenodo** (CERN's research archive):
   permanent, versioned, with a DOI. Builder: verify Zenodo's policy accepts it before relying on it. Zenodo
   is the fallback download URL in the manifest. If the corpus service ever goes away, the latest release
   is still downloadable and verifiable.
4. **The kit downloads it.** `chatwarden terms install en es pt` fetches the release, checks the signature,
   unzips, and loads. Releases are pinned in the adopter's config; updates are opt-in.

The engine's default install has no terms. Adopters install a term pack explicitly, verified by signature.

### Packages (npm workspaces, TypeScript, ESM, Node ≥ 22.13)

The table lists the domain packages. Also in the workspace: `@chatwarden/profanity` (optional starring),
`@chatwarden/express` and `@chatwarden/socket.io` (stack adapters), `@chatwarden/eos` (later), and the `chatwarden` CLI
(`init`, `coop setup`, `eval`).

| Package | What | Comes from in Moxgate |
|---|---|---|
| `@chatwarden/core` | Pure domain, no IO. Identity linking, evidence buffer, reports (intake, rate limits, dedupe, bad-faith record, reporting suspension), sanctions (chat / open-area / full ban / warning; groups; linked targets; IP cap), strikes + auto timeouts, the ladder, the Community Rules registry + rule-gap loop, notices (own-lines excerpt). Defines `Store`, `Clock`, `Hasher`, `Platform` interfaces. | `server/moderation/{identity,chatBuffer,reports,sanctions,strikes,mutes,enforcement}` + 11-09 spec B/C |
| `@chatwarden/store-sqlite` | `Store` on `node:sqlite`, with its own migrations and table prefix (`kit_`) | migration v29/v33 tables |
| `@chatwarden/matcher` | Term matcher on `obscenity`, with invisible-char stripping, repeat collapsing and name views. Loads term packs, and runs the negative-corpus gate on every live edit. | `slurMatcher`, `nameCheck`, `termsStore` |
| `@chatwarden/ai-read` | Optional. Report read with a fixed output schema, a provider interface, `anthropic` and `openai-compatible` adapters, a policy builder from the Community Rules plus a context pack (e.g. `games`, so "kill/destroy" is play talk), fixtures and an eval CLI | 11-09 spec A |
| `@chatwarden/discord` | Forum feed: one thread per reported player; report and outcome posts; AI tag; hub links; no chat by default | `discordFeed`, `forumClient` |
| `@chatwarden/http` | Framework-neutral request handlers (admin API, player notices API, rules JSON), plus a thin Express adapter | `modAdminRoutes` + 11-09 notices API |
| `@chatwarden/hub-react` | The moderator hub: overview, queue, report page with the decision panel, player history, terms editor, rules + rule gaps, guide. Themable through CSS variables. | `deploy/ovh/ops/ui/src/moderation/*` |
| `@chatwarden/player-react` | Player-side components: report dialog, notice dialog, rules page, restricted-chat line | `ReportDialog`, ChatPanel bits, 11-09 notice |
| `@chatwarden/coop` | Coop adapter (below): report forwarding, action-callback receiver, `coop setup` checklist and verify | new |
| `examples/tiny-chat` | A minimal Express + ws chat room using every package, the integration test bed and the README's demo | new |

### The platform boundary

The kit never owns transport, rooms or accounts. It does keep a light **room roster**, so reports and
evidence know who sat where. The adopter's side:

```ts
interface Platform {
  /** Who is behind a connection or request: stable browser key, optional account, optional IP (hashed by the kit). */
  identify(ctx: unknown): { clientKey?: string; accountId?: string; ip?: string | null };
  /** Push a player event (notice pending, report outcome, chat refused) to a person's live connections. Optional;
   *  without it the player picks events up through GET /notices on their next request. */
  notify?(who: KitSubject, event: KitPlayerEvent): void;
}
```

The kit API the adopter calls, all synchronous on the hot path (in-memory indexes), with storage writes async
behind it:

- **Rooms**:
  - `kit.rooms.seat(roomId, seatId, who, handle, tags?)`, `kit.rooms.unseat(roomId, seatId)`,
    `kit.rooms.close(roomId)`.
  - `tags` are free-form (`{ format: 'commander' }`) and shown in the hub.
  - A seat can change hands; the roster is time-stamped, so evidence lines carry the identity that wrote
    them. This is the 11-09 `p` index, generalised.
- **Chat**: `kit.chat.accept(roomId, seatId, text, { audience?: seatId[] })` → `{ deliver: { lineId, text } }` or
  `{ refuse: { reason, rule?, until?, noticeId? } }`. It covers:
  - the length cap, the rate limit, the slur matcher and strikes/auto timeouts (with the in-memory fallback)
  - the active chat restriction check
  - optional profanity starring (`@chatwarden/profanity`, below)
  - an optional `gate(roomId, who) => boolean` hook for "signed-in only" tables
  - The adopter still broadcasts. `audience` (team chat) is recorded with the line so evidence shows who
    could see it. `kit.chat.visibleTo(roomId, viewerSeat, senderSeat)` applies lasting mutes per recipient.
- **Mutes**: `kit.mutes.set(viewer, target, on)`, `kit.mutes.mutedSeats(roomId, viewerSeat)`.
- **Reports**: `kit.reports.submit({ roomId, reporterSeat, targetSeat, category, note?, lineId? })` →
  `{ ok, reportId } | { refused: 'off' | 'not_player' | 'self' | 'rate' | 'duplicate' | 'suspended', remaining? }`.
  - A report against a seat with no chat line (cheating, disruption) is normal.
  - Dedupe is per reporter × target × room, as today.
  - The same function backs the HTTP route that service mode uses.
- **Doors**: `kit.doors.check('join' | 'create' | 'public' | 'matchmaking', who)` → `null | { kind, until, noticeId }`.
- **Notices**: `kit.notices.pending(who)`, `kit.notices.ack(who, id)`, `kit.notices.record(who)` (the "My record" view).

**Subjects.** The kit issues an opaque, random **subject id** per person. It is the thing sanctions, history and
external systems (Coop, EOS, webhooks) refer to. Identifiers seen together are linked to one subject; when two
subjects merge (a key later signs in to an account), the older id survives and the other becomes an alias. It
is never a hash of a key, account or address. This replaces Moxgate's `a:`/`k:` refs in the hub.

**Hashing.** The kit's `Hasher` is byte-compatible with Moxgate's `makeHasher`: HMAC-SHA256 over
`${kind}:${input}`, first 32 hex characters, with the adopter's secret. Without that, sanctions migrated in K6
would match nobody. This is the default, and the docs tell new adopters to pick a secret and never change it.

Moxgate's seats, teams, casual/strict engines and draft chat stay in Moxgate. They become a `Platform`
implementation plus `rooms.*` / `chat.*` / `doors.*` calls at the existing hook points.

### Storage

- `Store` is an **internal seam** in v1 (not a documented third-party contract), with an **async** interface,
  so a Postgres store can come later without breaking callers. Hot-path reads come from in-memory indexes
  loaded at boot and after writes, as `SanctionIndex` does today.
- `store-sqlite` takes **either** a file path (its own database; what `init` scaffolds) **or** a host
  `DatabaseSync` handle (Moxgate's accounts DB). Either way it keeps its own schema version in a `kit_meta`
  table and its own `kit_`-prefixed tables, never touching the host's `meta.schema_version`.
- Node ≥ 22.13 (`node:sqlite` without a flag).

### Profanity starring and test data

- **Starring ordinary swearing is a separate optional package**, `@chatwarden/profanity`, wrapping `obscenity`'s
  English dataset. That dataset contains slurs, so it must not ride in the core install. Moxgate turns it on
  in K6, to keep today's behaviour.
- **The engine repo's tests use synthetic terms** (invented words with the same shapes: doubles, accents,
  leetspeak, word boundaries, innocent embeddings). Matcher mechanics are fully tested without real slurs.
  Precision on real terms is tested where the real terms live: the corpus service's submission gates and release CI (K7). During K6, Moxgate
  keeps its existing real-term tests in its own repo until the terms pack takes over.

### Roles

The kit's role check is per route, enforced by `@chatwarden/http` from the `role` the adopter's guard supplies.

| | moderator | owner |
|---|---|---|
| Queue, reports, decide, sanction, revoke, notes, history | yes | yes |
| Edit the live term list (with the negative-corpus check) | yes | yes |
| Rule gaps: see the list, close it out | see only | yes |
| Settings: kill switches, AI read on/off, Discord and webhook config, retention | no | yes |
| Audit log | read | read |

This matches Moxgate's 2026-11-07 decision (moderators maintain the slur list themselves). Moxgate's ops server
keeps its read-only-elsewhere rules; the kit only governs its own routes.

### Stacks

- **Packages**: `@chatwarden/express` (Express + `ws`) and `@chatwarden/socket.io`.
- **Recipes** (one complete file each): Fastify, Colyseus, a raw `ws` server, Nakama (via service mode).
- **Next.js** only on a long-lived Node server (custom server), or via service mode. Serverless route
  handlers can't hold the in-memory roster, and the docs say so.

### Two review backends

- **Built-in hub** (default). `@chatwarden/http` + `@chatwarden/hub-react` against the kit's store. One process, SQLite.
  Access control is the adopter's: the kit takes an `actor` string per request and a role (`moderator |
  owner`), and ships a guide for putting it behind Cloudflare Access or similar, as Moxgate does.
- **Coop** (`@chatwarden/coop`). The kit keeps evidence, sanctions and notices; Coop does review.
  - **Item model.** Each kit report is sent as its **own item**: a `chat-report` item type whose id is the
    kit report id. So every Coop callback names the report it concerns, and the adapter knows which report
    to close. The item's data carries:
    - the reported subject id (the opaque kit id, never a hash)
    - the category
    - the room tags
    - the AI read's severity, if any
  - **Reports out** (`POST /api/v1/report`):
    - `reportedItem` = the `chat-report` item.
    - `reportedItemThread` = the evidence lines, as a `chat-line` item type with `datetime`, author labelled by
      role and subject id.
    - `reportedItemsInThread` = the reported line.
    - `reporter` = `{ kind: 'user', typeId: <adopter's user type>, id: <reporter's subject id> }`.
    - `reportedForReason.policyId` = the Coop policy mapped from the category (adopter config, a
      category → policy map that `init --coop` scaffolds).
    - `reportedForReason.reason` = the reporter's note.
  - **Decisions in.** One kit endpoint receives Coop's action callbacks and verifies `Coop-Signature`. The kit
    defines a fixed set of Coop **custom actions**, and the adopter creates them in Coop from a printed
    checklist: Warn, Restrict chat 24 h / 7 d, Open-area ban 24 h / 7 d, Full ban 7 d / 30 d / permanent,
    **Dismiss**, **Dismiss as bad faith**. Coop's IGNORE and "Invalidate reports" send no callback, so they
    are not used. Each callback maps:
    - the action id → the kit action
    - `policies[].id` → a Community Rule number (via the policy map)
    - `actorEmail` → actor
    - `decisionReason` → the private reason
    - `item.id` → the kit report
    - Then the same decide path as the built-in hub runs: verdict, sanction, notice, report close, reporter
      feedback, bad-faith record.
  - **Retries.** Coop retries 5× with backoff and sends no request id or timestamp. So the decide path is
    **idempotent by content**: a second callback for the same report + action + rule within 24 h is a no-op
    that returns 200. A report already closed ignores further decisions except an explicit re-decide from
    the built-in hub.
  - **Excerpt in Coop mode.** Coop has no line picker. The notice carries the reported line when it belongs
    to the target, otherwise no excerpt.
  - **Rules sync.** Coop documents no policy-write API (`GET /api/v1/policies` only). So
    `chatwarden coop setup` prints the policies to create (name + `policyText` from the Community Rules) and the
    custom actions with their callback URL. It then verifies both by GET and writes the id maps to config.
    Builder: re-check the current Coop API at build time.
  - **Plugin types.** Coop's plugin types package name differs between its docs (`@roostorg/coop-types`) and
    its example (`@roostorg/types`). Resolve at build time. Only the adapter's types depend on it.
  - **No AI read as a Coop signal** (corrected 2026-11-09). Coop signals run on submitted items (`STRING` /
    `IMAGE` / `FULL_ITEM`) without a report thread. Running ours there would be AI on live chat, a non-goal.
    The game-context policy and fixtures go to ROOST's model community as a contribution instead. The kit's AI
    read still runs in Coop mode, on the kit side, and its severity rides in the item data.
  - **Our UI and Coop.** Coop has no UI-extension point that we found. So "our UI as an adapter to ROOST"
    means our player-side components and notices, driven by Coop decisions, alongside Coop's Review Console.
    Revisit if Coop adds one.
  - **Appeals.** Out of scope, but the adapter's types leave room for `POST /api/v1/report/appeal`.

### AI moderation: the headline feature, in levels

The pitch: "Your game has chat and no moderation team. Chatwarden gives you one." Every level is opt-in, set by
the adopter per installation, and each level includes the ones below. All levels share one engine
(`@chatwarden/ai-read`):
- the Community Rules, plus a context pack (`games` first: "kill/destroy/exile" is play talk)
- role-labelled input with no identifiers
- a fixed output schema
- a daily budget
- the fixture eval gate

| Level | What the AI does | Human role | Player sees |
|---|---|---|---|
| **0 Off** | nothing | everything | — |
| **1 Read** | Reads each report: severity, rule, one-line summary, evidence lines. Ranks the queue. (11-09 part A.) | decides everything | — |
| **2 Recommend** | Also proposes the whole decision: fair / unfair / bad faith, the ladder step for this record, the rule, the excerpt lines to show. The decision panel opens pre-filled and clearly marked "AI suggestion". | confirms or edits, one click | the moderator's decision |
| **3 Act on clear cases** | For a narrow, adopter-tuned class (default: severity high + confidence high + CR 1 slurs or CR 2 threats, with a server-witnessed excerpt), applies a **short** action itself: Warning, or a chat restriction of at most 24 h, never a ban. The report stays open for a human to confirm or reverse within a review window. | reviews after the fact; a reversal withdraws the notice | "An automatic check restricted your chat. A moderator will review it." |
| **4 Watch** | Reads **delivered** chat asynchronously, never delaying or blocking a message. A cheap pre-filter (matcher hits, rate spikes, mute or leave events nearby) picks lines worth a look. A high-severity read files a **system report** with server evidence. It catches abuse nobody reports; victims often just leave. | the system report goes through levels 1-3 like any other | as for the resulting decision |

Rules that hold at every level:
- **Clear provenance.** Every AI-originated row has `source: 'ai'`, `automated: 1`, the model id and the read
  id. The hub labels it. The Recent actions feed can filter AI actions.
- **Hard ceilings in code, not config:**
  - the AI can never ban
  - never act beyond 24 h
  - never act on a report whose excerpt has no line from the target
  - never act on a subject with a moderator "do not automate" note
  - never act on reporter-only signals (other players' flags never count on their own, the fairness rule)
- **Reversal is cheap.** One click in the hub. It withdraws the notice and records a "reversed AI action",
  which feeds the eval set (fixtures added by humans, never automatic training).
- **Measured.** The hub shows, per level, the AI-vs-moderator agreement rate over the last 30 days. Levels 3-4
  show a banner when agreement drops below a threshold (default 90%), and level 3 pauses itself below 80%.
- **Cost-bounded.** A per-day budget per level. Level 4's pre-filter keeps cost proportional to trouble, not
  to chat volume. The hub shows spend.
- **Privacy.** Level 4 means delivered chat lines (pre-filtered) go to the model provider. The adopter must
  set `ai.watch.disclosed = true` (acknowledging their privacy policy says so) before level 4 starts.

**Moxgate's setting** is owner question 8. Its 2026-11-07 spec excluded AI on live chat and automatic
sanctions; the kit offers them, and Moxgate chooses.

**Beyond enforcement** (small, same engine):
- `chatwarden rules draft`: describe your community and get a first draft of Community Rules to edit.
- AI-assisted term review in the corpus service's submission gates: a second opinion on a proposed term's innocent senses, never
  a substitute for the fluent human reviewer.
- A plain-language weekly digest for the owner: what happened, what the AI did, any rule gaps.

### Additions from the industry survey (beyond the 11-09 spec)

From `docs/research/2026-11-09-moderation-industry-survey.md`. The 11-09 spec's features stay as written; these
extend them in the kit, and Moxgate gets them in K6:

1. **Reporter feedback, on action only.** When a report leads to any action, the reporter gets a minimal
   notice on their next visit: "Thanks. We took action on a report you made." No who, what or how long.
   A dismissal sends nothing; Discourse feedback shows "we disagreed" replies cause fights. This is the
   pattern in Riot's Valorant patch 3.08 and in Discourse's canned flag replies. It uses the same notice
   channel as part C.
2. **Reference id per action.** A short, human-readable code (e.g. `M-7K3Q9`) on every sanction group.
   It is shown in the player's notice and asked for in the "think this is a mistake?" link, so a support
   conversation starts from the right record. EOS has `referenceId`.
3. **Where an action came from.** Every sanction row records:
   - `source`: `moderator | auto_filter | coop | api`
   - `automated` (0/1)
   - `pending`: a recorded action not yet enforced, e.g. while `MOD_SANCTIONS=off`
   This makes "the AI never decides" auditable from the data, not just the code. It follows EOS, with
   Steam's report-source flags as precedent.
4. **The player's own record.** A read-only "My record" view (player-react, behind the same notices API).
   It lists active sanctions and warnings from the last 90 days, each with its rule, end date and reference
   id. A revoked action disappears from it. Xbox and Discord both offer this.
5. **Explain at the point of block.** When the filter refuses a message, the refusal names the rule ("That
   word isn't allowed here. Community Rule 1."). Today it only says the message was blocked. Discord
   AutoMod's custom message and Twitch's held-message notice do the same.
6. **Report budget made visible.** The existing 10-reports-a-day cap shows how many reports the player has
   left once they get low, as PlayFab does.

Rejected from the survey: auto-silencing a player on other players' flags (Discourse), because it breaks the
fairness rule. Reporter accuracy weighting in queue order is owner question 6.

### Adapters beyond Coop

- **Generic signed webhooks, out and in** (part of `@chatwarden/http`, K3). **Out**: `report.created`,
  `report.closed`, `sanction.applied`, `sanction.revoked`, signed HMAC-SHA256 with a timestamp. **In**: an
  `apply-action` endpoint with the same signature scheme, so any backend can drive the kit. This is the cheap
  adapter that covers everyone else.
- **Epic Online Services Sanctions + Reports** (`@chatwarden/eos`, after K6). Kit sanctions map to EOS sanctions
  (create/patch/delete with `referenceId`), and EOS player reports come into kit reports. It is the best-
  documented game-platform API in the survey.
- Later, only on request: PlayFab `BanUsers` / `RevokeBans` (full bans only), the Steam
  `ICheatReportingService`, and a Nakama module.

### Built for agents to find and adopt (owner 2026-11-09)

> "People building games and indie games that have chat can leverage this, that their chat agents and Claude
> Code can find it and be like, cool, I'll just start with this."

Target moment: a developer tells their coding agent "add moderation to my game's chat". The agent finds the
kit, picks it, and wires it in one session, with the safe defaults on. So:

1. **One command to start.** `npx chatwarden init` detects the stack (Express/Fastify + ws, Socket.IO, Colyseus,
   Next.js route handlers, or "other / not Node" → service mode). It writes the wiring, a SQLite file
   location, the hub mount, and a `MODERATION.md` checklist of what is on and what is left to the developer.
   The checklist covers rules wording, the privacy paragraph and the Discord webhook. It is idempotent and
   prints a diff-style summary, so an agent can verify what changed.
2. **Service mode for stacks that aren't Node.** Many indie servers are C# (Unity, Mirror, Photon), Go, Rust,
   Godot or Nakama. `chatwarden-server` is a **Docker image** (no single binary in v1) running the same packages
   behind `@chatwarden/http`.
   - **API.** The HTTP API mirrors the kit API one-to-one: `POST /rooms/seat`, `/rooms/unseat`,
     `/rooms/close`, `/chat/accept`, `/reports`, `/doors/check`, `/mutes`, `GET /notices`, `POST /notices/:id/ack`.
   - **Auth.** The game server authenticates with a bearer token from the service's config, and sends the
     player's `clientKey` / `accountId` / `ip` in each body. The service trusts its caller for identity; it
     is never exposed to players directly.
   - **Push.** `notify` becomes the signed outbound webhook (`player.event`). Polling `GET /notices` is the
     fallback.
   - **Limits.** v1 is single instance (the roster and evidence buffer are in memory). A restart loses
     unreported evidence, as Moxgate does today, and the docs say so.
   - Copy-paste client snippets for C#, GDScript, Go and Lua. The hub is served by the same process.
   - This is a new phase, **K4b**.
3. **Agent-readable docs.**
   - `llms.txt` and `llms-full.txt` at the docs root.
   - An `AGENTS.md` in the repo, with the integration steps, the invariants not to break (never send
     identifiers to the AI, never auto-sanction on reports, no chat in Discord) and the test command.
   - One recipe page per stack, each a complete working file.
   - Every public function has a TSDoc example.
4. **A Claude Code plugin in the repo.** A `.claude-plugin/` marketplace manifest plus an
   `add-chat-moderation` skill. The skill is short: detect the stack, run `init`, wire the chat hook and
   doors, mount the player components, run the example test. So `/plugin marketplace add hainix/chatwarden`
   followed by the skill does the integration. The same steps live in `AGENTS.md` for Cursor, Copilot and
   other agents.
5. **Findable.**
   - A plain descriptive tagline ("Open-source chat moderation for games and small communities: reports,
     sanctions, player notices, slur filter, optional AI review").
   - npm keywords and GitHub topics: `chat-moderation`, `game-chat`, `trust-and-safety`, `content-moderation`,
     `profanity-filter`, `discord`, `coop`.
   - Docs indexed by Context7.
   - Listed in ROOST's community resources once K5 works (owner question 9 of the brainstorm), and in
     game-dev awesome lists.
   - The name itself should say what it is (owner question 1).
6. **An agent integration eval.** A fresh coding agent gets the `examples/bare-*` starters (a bare Socket.IO
   game and a bare Colyseus game) and the prompt "add chat moderation". It passes when the starter's
   moderation acceptance tests go green:
   - a synthetic test term is refused
   - a report stores server evidence
   - a warning produces a notice
   - Discord gets no chat text
   - **the invariants**: no identifier reaches the AI provider (a recording mock provider), and no report
     sanctions anyone without a decision
   This is the measure of "agents just start with this". Cadence, model and budget are owner question 4. A red
   run does not block merges, but a release needs the last run green. Builder: use `claude plugin eval` for
   the plugin's skill.
7. **Safe by default after `init`:**
   - The term pack is installed only on an explicit `--terms en` (the engine stays empty otherwise; the
     prompt says so).
   - AI read stays off.
   - Discord excerpts stay off.
   - Retention defaults stay on.
   - The hub is refused until an access guard is configured (`init` scaffolds a shared-secret guard and
     says to replace it).

### Data ownership and privacy defaults

- Stored by default: excerpts witnessed by the server (no client-supplied evidence) and hashed IPs (keyed hash,
  adopter secret). Retention defaults to 90 days for reports and 90 days after a sanction ends; all
  configurable.
- Never in a player-facing frame: keys, hashes, account ids, other players' lines, reporter identity, the
  moderator's reason.
- Discord: no chat text by default. An adopter can turn excerpts on explicitly, with a warning in the docs.
- AI read: role labels only; no identifiers. Off by default.
- A privacy-policy paragraph template ships with the docs, labelled "not legal advice", after counsel
  reviews Moxgate's wording.

## Phases

The **11-09 spec is the feature contract**. Its parts A/B/C are built here (K2, K3), not in Moxgate.

- **K0. Repos and framing.**
  - Create the repo (owner question 2) with LICENSE / LICENSE-DATA, a DCO bot, CODEOWNERS and a
    CONTRIBUTING that says "as-is, no SLA, PRs welcome, DCO sign-off".
  - The README leads with what the kit is not (no child safety, no hosting).
  - CI: typecheck, unit tests by package, and the example app's integration test.
  - Changesets for versioning.
- **K1. Core, SQLite store, matcher.**
  - Written fresh against the API above, with Moxgate's modules as the reference for behaviour.
  - Their test cases are the checklist. Each one is rewritten as a kit test first (red), then made green;
    real slur terms are replaced by synthetic ones.
  - Moxgate-specific code (rooms, seats, protocol frames) is not carried over.
- **K2. Rules, Warning, ladder, notices.**
  - 11-09 spec part B (Community Rules, rule gaps, Warning, ladder) and part C (notices, own-lines excerpt,
    `p` index), built in `core` + `http` + `player-react`.
  - The `/rules/` page is a `player-react` component the adopter mounts.
- **K3. AI read and Discord.**
  - 11-09 spec part A in `ai-read` (providers, policy builder, `games` context pack, fixtures, eval CLI).
  - The Discord feed in `discord`, including the AI tag and the edit-in-place post.
- **K4. React UI.**
  - `hub-react` (the 2026-11-08 dashboard redesign is the starting point) and `player-react`.
  - Accessible, themable, en strings plus an i18n hook (the adopter passes `t`); Moxgate passes its 6 locales.
  - Storybook-style fixtures, or the example app, for screenshots.
- **K5. Coop adapter.**
  - As above. Tested against recorded Coop request/response fixtures.
  - One manual end-to-end against a local Coop (`docker compose`) before calling it done.
- **K6. Moxgate adopts.** In order:
  1. Moxgate depends on the kit packages (owner question 3).
  2. Write a `Platform` adapter.
  3. Swap modules one at a time behind Moxgate's existing tests.
  4. Data migration from Moxgate's v29/v33 tables into the kit's tables, in one migration with a dry-run and
     a count check.
  5. The ops hub mounts `hub-react`.
  6. The client mounts `player-react` components styled to Moxgate.
  - Kill switches keep working (`CHAT_MODERATION`, `MOD_SANCTIONS`, `MOD_AI_READ`).
  - Ship as one release after a staging soak, since push = deploy.
- **K7. Term corpus.** Per `docs/research/2026-11-09-community-term-corpus.md`:
  - One file per term, OSV-style ids, `provisional | accepted | disputed | withdrawn`.
  - Must-block and must-never-block lines per term; the cross-language negative gate; two human approvals
    including a fluent speaker.
  - The seed is exported from production (`mod_terms` + audit), **not** the repo seed file. It is published
    as `provisional` with a source per term.
  - A cleaned AI-review record (term ids and reason categories, no slurs in prose).
  - Contact GitHub support before going public.

- **K4b. Adoption surface.**
  - Everything in "Built for agents to find and adopt": the `init` CLI, the service-mode image and its
    snippets, `llms.txt` / `AGENTS.md` / the recipes, the Claude Code plugin + skill, and the nightly agent
    integration eval.
  - It ships with the first public release. A kit agents can't find is the failure this owner question
    exists to avoid.

- **K3 (extended). AI levels.**
  - Levels 1-2 ship in the first public release. Level 3 ships behind its ceilings once the eval gate and a
    Moxgate soak at level 2 show agreement ≥ 90%. Level 4 follows level 3.
  - Each level gets its own fixtures and its own row in the eval table.
- **K8. Landing page and docs site.** Built in the kit repo (`site/`), deployed to Cloudflare Pages (the
  owner's existing Cloudflare account), on its own domain (owner question 9).
  - **Landing page.** One page, leading with the AI moderation pitch:
    - a live **playground**: type chat lines and see the matcher, a recorded AI read and the notice the
      player would get, with no API key needed
    - the four AI levels
    - "works with Coop / Discord / any game server"
    - a 3-step quickstart
    - "used by Moxgate"
    - the honest no-SLA line
  - **Docs.** Quickstart per stack, concepts (subjects, evidence, rules, levels), API reference generated
    from TSDoc, the Coop guide, the privacy template, `llms.txt`.
  - **Design.** Its own visual identity, not Moxgate's. Built with the frontend-design skill; screenshots
    and the playground come from `examples/` so they never drift.

Order: K0 → K1 → (K2 ∥ K3) → K4 → K4b + K8 (first public release) → K5 ∥ K6 → K7. AI levels 3-4 land after
K6's soak. K7's governance work can start any time. The seed export
waits for K1's schema.

## Testing

- Test-first per owner directive, targeted runs only: per-package `vitest run <path>`. Never a full Moxgate
  suite locally.
- The kit's CI runs its whole suite (it is small and separate from Moxgate's deploy box). The no-full-suite
  rule is about Moxgate's local runs, and the kit's local runs stay targeted too.
- Every 11-09 spec test list carries over.
- Kit-specific:
  - `core` has no IO imports (lint rule)
  - every package is exercised by `examples/tiny-chat`
  - a Coop callback replay is idempotent
  - the Discord payload never contains excerpt text unless opted in
  - the term-pack checksum is verified

## Left to the builder

Internal module layout, the store's SQL, the build tooling details (tsup/tsc), the CSS approach for themable
UI, example app styling, and the docs site generator (or none: Markdown in the repo is fine).

## Owner questions

All recommendations accepted by the owner on 2026-11-09.

1. **Name: Chatwarden** (owner 2026-11-09). Free on npm and as a GitHub name; `npm` scope `@chatwarden`.
2. **Repo.** `hainix/chatwarden`, **private until the first public release** (end of K4b), public before K6
   so Moxgate's deploy box installs from npm with no tokens. The agent creates it (private). The npm org
   `@chatwarden` needs the owner's npm account.
3. **How Moxgate consumes it** (K6). **Recommended: published npm packages, pinned exact versions.** No git
   submodules or workspace links, because Moxgate's push is its deploy and must be reproducible.
4. **Agent eval.** Which model, which key, how often. **Recommended: weekly and before each release (not
   nightly), Sonnet, a separate API key with a monthly spend cap you set.** Nightly costs more than it tells us
   at this stage.
5. **Reporter accuracy in queue order** (Discourse-style). **Recommended: not in v1.** It can bury true reports
   from new players. The bad-faith record and suspension already handle repeat false reporters. Revisit with data.
6. **The term corpus.** **Recommended: take the corpus research's 15 answers as written**
   (`docs/research/2026-11-09-community-term-corpus.md` §8). These need you personally:
   - (a) who is the second human English reviewer (a trusted community member or moderator)
   - (b) ~~emailing GitHub support~~: dropped (owner 2026-11-09). The terms live on our own corpus service
     instead (see "Where the terms themselves live").
   - (c) the one widely used in-group term stays off the default pack, as Moxgate decided 2026-11-08
7. **The 11-09 Moxgate spec.** **Recommended: approving this doc also approves the 11-09 spec as its feature
   contract**, built in the kit (K2/K3) rather than in Moxgate.
8. **Moxgate's AI level.** **Recommended:**
   - level 2 (Recommend) at adoption
   - level 3 (Act on clear cases) after a month at ≥ 90% agreement
   - level 4 (Watch) only once level 3 has held up, with a Privacy Policy line first
   This changes the 2026-11-07 "no AI on live chat, no automatic sanctions" rule for Moxgate, which is your
   call.
9. **Domain.** `chatwarden.dev`, `.org`, `.io` and `.gg` returned no DNS records on 2026-11-09, which suggests
   they're unregistered (`.com` is taken). Check with a registrar. **Recommended: `chatwarden.dev`**
   (developer audience; Cloudflare Registrar sells `.dev`), bought by you.
10. **Default model in docs and `init`.** The kit stays provider-neutral. **Recommended: the docs and `init`
    suggest Claude Haiku for levels 1-2 and 4, and Sonnet for level 3's decisions**, with an OpenAI-compatible
    adapter for everyone else. The builder confirms prices from the claude-api skill at build time.
