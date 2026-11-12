---
status: draft, awaiting controller rulings (section 17)
updated: 2026-11-12
release: versions are assigned in merge order; each integration (Discord bot, Coop, EOS) may ship in its own release
---

# K5: integrations with outside moderation and game platforms

Chatwarden decides, enforces and tells the player. Three outside systems sit next to that loop, and each one is a place where an adopter
already works: **Discord** (where a small team already talks), **Coop** (ROOST's open-source review console), and **Epic Online Services**
(where an EOS game already keeps sanctions and receives reports). This note adds one adapter for each, inside the packages that exist
today, and puts nothing on by default.

Product scope, section 8, row "Coop adapter, EOS sanctions and reports" (K5, "no" for Moxgate) and the new row "Discord bot: report and
outcome feed plus button deep links (exists); slash commands `/chatwarden lookup <ref>`; optional 'act from Discord' with role checks".
The 2026-11-09 design (`2026-11-09-chatwarden-design.md`, "Two review backends" and "Adapters beyond Coop") sketched Coop and EOS as two new
packages, `@chatwarden/coop` and `@chatwarden/eos`. This note replaces that packaging (ruling 1) and corrects one of its claims: Coop
now has a custom-signal plugin mechanism, so "the AI read as a Coop signal" is possible after all (section 8.7).

## 1. Why

**Discord.** The feed (`@chatwarden/discord`) already puts every report, decision and lifted sanction into one forum thread per person. It
can only write: a channel webhook cannot take a click. A moderator who sees "Severe report" in Discord opens the hub in another tab to
do a thing that is one decision on a known report. And a player who quotes a reference code (`M-7K3Q9`) to a moderator in Discord makes the
moderator open the hub to find what it is. Two small features close those gaps: a slash command that answers "what is this reference
code", and, for teams that want it, two buttons on the report post that act, behind the same roles and audit as the hub.

**Coop.** A studio that has outgrown the hub, or that already runs Coop for other content, should not have to rebuild the player-facing
half (reports, notices, enforcement). The kit keeps evidence, sanctions and notices; Coop is a review surface. The adapter sends each
report to Coop and turns Coop's decisions back into kit decisions through the same path the hub uses, so a notice, a strike and a record
look the same whichever tool decided.

**EOS.** An EOS game already has a sanctions list and a reports list in the Developer Portal, and a client SDK call that reads a player's
active sanctions. A kit sanction that never reaches EOS is invisible there; an EOS player report that never reaches the kit never reaches
a moderator. The adapter pushes kit sanctions to EOS and pulls EOS reports into the kit, within what EOS's Web API allows (section 9.1: that is
narrower than the 2026-11-09 sketch assumed).

## 2. Goals and non-goals

### Goals
- A slash command, `/chatwarden lookup <ref>`, that answers a reference code in Discord, for moderators, audited.
- Optional "act from Discord": buttons on a report post that dismiss it or apply the profile's suggested step, with a confirm step, role
  checks mapped to the kit's roles, the same audit rows as the hub, and a clear answer when the report was decided elsewhere meanwhile.
- A Coop adapter: a report goes out as a Coop job; a moderator's decision in Coop comes back, verified, and runs `cw.decide`; the kit's AI
  severity can ride along, and a Coop plugin can expose the AI read as a signal.
- An EOS adapter: kit sanctions become EOS sanctions (create, remove), and EOS player reports about players the game can place in a room
  become kit reports.
- Every integration is opt-in, off by default, constructed explicitly, validated once (`RangeError` that never echoes a value), disposable.
- Secrets are options, never logged, never in an error message. Logs carry event names and error classes only.
- Every external service has a test fake, so no test touches the network.
- No new npm package. Nothing that needs the owner's one-time manual publish.

### Non-goals
- Replacing the hub. The hub stays the default review tool.
- A Discord gateway bot (a long-lived socket, intents, sharding). The kit uses HTTP interactions only.
- Child-safety detection and CSAM reporting (a product non-goal; point to Coop and HMA). The adapter never sets `csam` on a report.
- AI that bans. The AI severity is advisory in every integration; no integration lets an automated verdict become a sanction.
- Voice, images, and any media in a Coop item.
- Mirroring state both ways beyond what each API offers (section 8.5 and 9.4 list the gaps).
- Appeals through Coop or EOS (K10 owns appeals; the types leave the seams, section 12).

## 3. Rulings (decided here; the sections below follow from them)

1. **Ruling: three new subpaths of `@chatwarden/http`, one small generic hook in `@chatwarden/discord`, two small additions to
   `@chatwarden/core`, and no new package.**
   - `@chatwarden/http/discord`: the interactions endpoint (signature check, ping, commands, buttons), `registerCommands`.
   - `@chatwarden/http/coop`: the Coop adapter.
   - `@chatwarden/http/eos`: the EOS adapter.
   - `@chatwarden/discord` gains `components` on `discordFeed` (buttons on a report post) and removes those buttons when the report closes.
   - `@chatwarden/core` gains `cw.sanctions.byRef(refCode)` (no migration: the unique `ref_code` index exists) and `cw.links`, a small
     generic table for "this kit id is that outside id" (one migration, needed only by Coop and EOS).
   - Trade-offs, three options weighed:

     | Option | For | Against |
     | --- | --- | --- |
     | **A. Subpaths of http (chosen)** | Reuses `PERMISSIONS`, `applyDecision`, claims, audit, `sign`, `ReplayCache`, `RouteTable` and `toExpress` (rawBody) with no re-export. No first publish by hand, so the OIDC release path is unchanged (RELEASING.md). The interactions endpoint is served by the same router as every other route. | `http` grows by three Node-only subpaths (none is exported from the root, so a browser bundle of the root is unchanged). The http peer floor on core rises. |
     | B. Bot inside `@chatwarden/discord/bot` | Everything Discord in one package. | The bot needs the permission map, the decision path, the claim gate and the audit helper that live in http; either the discord package peers on http (a dependency that points the wrong way, and http already dev-depends on discord) or it copies them and drifts. |
     | C. New packages `@chatwarden/coop`, `@chatwarden/eos`, `discord-bot` | Smallest per-package surface, matches the 2026-11-09 sketch. | Each is a first publish the owner must do by hand with the token before OIDC works (RELEASING.md, "New packages: the first publish"), three times; the release workflow's dependency order and `check-pack`, `smoke` and `manifests` tests grow three rows. |

   The seam that keeps A clean: `@chatwarden/discord` knows nothing about the bot. The feed takes a `components(post)` function; the bot
   exposes one. They meet only in the adopter's wiring (section 6.1). `@chatwarden/http/discord`, `/coop` and `/eos` are **not** re-exported
   from the root (the chat subpath is, because it is browser-safe; these three use `node:crypto`).
2. **Ruling: everything is opt-in, constructed explicitly, and does nothing at import.** Each adapter is a function the adopter calls with
   options; there is no module-level side effect (`sideEffects: false` stays). A required option has no default where the choice is a
   privacy choice (Coop's `evidence`, section 8.3). Nothing reads an environment variable: the adopter passes values in.
3. **Ruling: the kit is the source of truth for enforcement state in every integration.** Sanctions, notices, report status and the
   record live in the kit's store. Discord, Coop and EOS are surfaces: they show it, and (Discord, Coop) can ask the kit to change it
   through the kit's own decision path, which applies the kit's validation, idempotency and audit. A decision made anywhere else first
   wins; a later one for the same report is acknowledged and not applied (sections 6.6 and 8.5).
4. **Ruling: a human decision from Discord or Coop is a `moderator`-source decision (Coop: `coop`) by a named actor, never an automated
   one.** The actor is `discord:<user id>` or `coop:<moderator email>`, both valid audit actors (the audit actor charset allows `:`, `@`,
   `+`, `.`, `-`). The `Source` union already has `coop`; Discord decisions use `moderator`, as the incoming webhook does. A Coop
   callback that no moderator made (a rule-triggered action, a strike threshold) is acknowledged and ignored (8.5).
5. **Ruling: chat text leaves the kit only where the adopter has said so, and only to Coop.** The Discord feed and bot never carry chat
   text, a handle, a reporter note or a reason (unchanged). EOS gets a fixed justification (the reference code and the rule), never the
   moderator's reason. Coop is a review tool: a reviewer cannot review what they cannot read, so Coop's `evidence` option is **required**
   (`'none'` or `'excerpt'`), has no default, and the reporter's note and the handles are separate, off-by-default switches.
6. **Ruling: the kit never stores an outside account identifier it did not already store.** The kit hashes identifiers on purpose. The EOS
   adapter therefore never keeps a `productUserId`: the adopter's own code resolves subject to product user id and seat to product user id
   (two small functions in the options), and `cw.links` holds only kit ids and outside job and sanction ids (section 5.1).
7. **Ruling: one migration, additive, shared.** `cw.links` needs a table. It is one migration (number assigned at merge: 22 if neither the
   appeals nor the flood-control release has merged, else the next free number) used by Coop and EOS. The Discord bot needs no migration and
   can ship first. A database opened by a release with the table is readable by the one before.
8. **Ruling: the interactions endpoint is a normal kit route.** `bot.routes` is a `RouteTable` (`POST /discord/interactions`), mounted by
   the adopter's router and adapter, which supply `rawBody` (the signature covers the exact bytes). It is verified before it is parsed,
   answers every failure with the same 401, and is rate limited by Discord user once it is verified.
9. **Ruling: the adapters run on the kit's clock and the adopter's `fetch`.** Every time comes from the injected `Clock`. `fetch`,
   `random` and the logger are options with the same defaults as `webhooksOut` and `discordFeed`, so a test injects fakes for all
   three and no test needs a port.
10. **Ruling: UI stays clean.** The always-visible Discord post gains at most two buttons, on the report post only, and only when the
    adopter turns "act from Discord" on; everything else (the lookup, the confirm step) is behind the slash command or an ephemeral
    message. The hub gains no control and no badge from this release. (Owner directive 2026-11-11, "clean core, power behind one door".)

## 4. External facts, with sources

Read on **2026-11-12**. Where a fact could not be read from the page, it is marked **UNVERIFIED** and listed in section 15 with the check
that settles it. Nothing here is from memory unless it says so.

### 4.1 Coop

| Fact | Source |
| --- | --- |
| Coop is ROOST's open-source review and moderation tool, Apache-2.0; repository `roostorg/coop`; releases up to 1.2.2 (published 2026-11-05); a Node and TypeScript server with REST and GraphQL APIs and a React console. | https://github.com/roostorg/coop and the GitHub releases API, 2026-11-12 |
| Docs are versioned; the API reference, the integrations list and the user guide live at `docs.roost.tools/coop/latest/`. | https://docs.roost.tools/coop/latest/ |
| Every API call needs `X-API-KEY: <key>` and `Content-Type: application/json`; the key is under Settings, API Keys. | https://docs.roost.tools/coop/latest/api/ ; `docs/development/api-auth.md` in the repo |
| Endpoints: `POST /api/v1/items/async/` (202, rules evaluated in the background), `POST /api/v1/report` (201 with `{ reportId }`), `POST /api/v1/report/appeal` (204), `GET /api/v1/policies/`, `GET /api/v1/actions/`, `GET /api/v1/item_types/`. | https://docs.roost.tools/coop/latest/api/ |
| Report body: `reporter { kind: 'user', id, typeId }`, `reportedAt` (ISO 8601), `reportedItem { id, typeId, data }`, optional `reportedForReason { policyId?, reason?, csam? }`, `reportedItemThread[]` (use a `datetime` field for ordering), `reportedItemsInThread[]` (`{ id, typeId }`), `additionalItems[]`. 400 on a schema mismatch, 401 or 403 on a bad key. | https://docs.roost.tools/coop/latest/api/report.html |
| Item types (`CONTENT`, `THREAD`, `USER`), their schemas and policies are created in Coop (read-only over the API: `GET /item_types`, `GET /policies`); the policy `id` is immutable, `name` is not. | `docs/api/item-types.md`, `docs/api/policies.md` in the repo |
| A decision in the Review Console, or a rule, or a strike threshold, triggers a `POST` to the callback URL configured **per action**; Coop also sends any auth headers configured there; failed deliveries are retried up to five times with exponential backoff. | `docs/api/actions.md` (https://docs.roost.tools/coop/latest/api/actions.html) |
| Callback body: `item { id, typeId, typeName }`, `action { id }`, `policies[] { id, name, penalty }`, `rules[]`, `custom`, and when present `actorEmail`, `actorNote`, `creator`, `decisionReason`, `userStrikeCount`. A moderator decision has `actorEmail` and `rules: []`; a rule-triggered one has no `actorEmail`; a strike threshold has empty `policies` and `rules`. For a decision on a reported item, `custom` also gets `reason` and `reportHistory[] { reason, reporter }`. | same page |
| Signature: header `Coop-Signature` (or `coop-signature`): base64 of an RSASSA-PKCS1-v1_5 / SHA-256 signature over the **raw request body**; verify with the "Webhook Signature Verification Key" (a public key, PEM) under Settings, API Keys. The body is not timestamped by this scheme. | https://docs.roost.tools/coop/latest/development/api-auth.html |
| The Review Console decisions are Ignore, Enqueue to NCMEC, Move, and the adopter's custom actions; "Ignore: close the job with no action taken". Moderators can "Invalidate reports" from a reporter (strips the reporter's entries from a job). | `docs/user/review-console.md`, `docs/user/reports.md` in the repo |
| Appeals: `POST /api/v1/report/appeal` and an Appeal Decision Callback (`appealDecision: ACCEPT or REJECT`). | `docs/api/appeal.md`, `docs/api/actions.md` |
| Partial Items API: Coop can `POST` to an adopter endpoint (`items: [{ id, typeId }]`) to fetch items on demand; optional. | https://docs.roost.tools/coop/latest/api/partial-items.html |
| **Custom integrations**: "Platforms deploying Coop can add any signal through a custom integration". A plugin is an npm package (or a local path) listed in `integrations.config.json`; it exports a manifest and signals; a signal can ask for context (`contextNeeds`: parent, thread up to `maxThreadMessages`, default 20, 90 days back) and returns a boolean or a number the rule compares with a threshold. Secrets go through the in-app config form, not the config file. | `docs/integrations/custom.md`, `docs/user/signals.md` in the repo; the example package https://github.com/roostorg/coop-integration-example (v2.0.1, 2026-08) |

### 4.2 Epic Online Services

| Fact | Source |
| --- | --- |
| The Web APIs (`https://api.epicgames.dev`) are "trusted server" services that supplement the EOS SDK; Sanctions and Player Reports are EOS Game Services. Other, undocumented endpoints must never be called. | https://dev.epicgames.com/docs/web-api-ref/web-api-introduction |
| Auth: an OAuth2 token endpoint `POST https://api.epicgames.dev/auth/v1/oauth/token` (`Authorization: Basic base64(clientId:clientSecret)`, form body `grant_type=client_credentials&deployment_id=<id>`); the answer has `access_token`, `expires_in` (3599 in the example), `deployment_id`; every call sends `Authorization: Bearer <access_token>`. What a client may do is its **client policy** (actions such as `sanctions:createSanction`). | https://dev.epicgames.com/docs/web-api-ref/connect-web-api |
| **Sanctions Web API** under `https://api.epicgames.dev/sanctions/`: create `POST /sanctions/v1/{deploymentId}/sanctions` (body: array of `{ productUserId, action [a-zA-Z0-9_-]{1,64}, justification 1..2048, source [a-zA-Z0-9_-]{2,64}, duration (integer seconds, optional), tags (items [a-zA-Z0-9_-]{1,16}), pending, metadata (max 25 pairs, key 64, value 128), displayName, identityProvider, accountId }`; answer `elements[]` with `referenceId`, `status`, `expirationTimestamp`); query `GET .../users/{productUserId}` and `GET .../sanctions` (paged), `GET .../active-sanctions`; update `PATCH .../sanctions` (`referenceId`, `updates`); remove `DELETE .../sanctions` (`{ referenceIds[], justification? }`, 204); appeals `POST .../appeals`, `GET .../appeals` (reasons 1 to 4); sync of events `GET /sanctions/v1/sync`. Client policy actions: `sanctions:createSanction`, `deleteSanction`, `updateSanction`, `findSanctionsForAnyUser`, `findActiveSanctionsForAnyUser`, `syncSanctionEvents`. | https://dev.epicgames.com/docs/web-api-ref/sanctions-web-apis |
| `referenceId` is EOS's id for a sanction (the example is a UUID); the active-sanction read returns `referenceId`, `timestamp`, `action`, `expirationTimestamp` (no justification). | same page |
| **Player Reports Web API**: send `POST /player-reports/v1/report` (`reportingPlayerId`, `reportedPlayerId` (must differ), `time`, `reasonId` (integer), `message` (max 1024), `context` (a JSON string, max 4096); 201; policy `playerreports:sendReportForAnyUser`); **find** `GET /player-reports/v1/report/{deploymentId}` with filters (`reportingPlayerId` and `reportedPlayerId` multi-valued; **they cannot both be empty**; `reasonId`, `startTime`, `endTime`, `pagination`, `offset`, `limit` default 50, `order`; policy `playerreports:findReportsForAnyUser`); reason list `GET /player-reports/v1/report/reason/definition`: 1 Cheating, 2 Exploiting, 3 Offensive profile, 4 Verbal abuse, 5 Scamming, 6 Spamming, 7 Other negative behavior. A returned report has `productId`, `sandboxId`, `deploymentId`, `time`, `reportingPlayerId`, `reportedPlayerId`, `reasonId`, `message`, `context` and **no report id**. | https://dev.epicgames.com/docs/web-api-ref/player-reports-web-apis |
| Client side: the same features are in the EOS SDK ("EOS > Sanctions Interface", "EOS > Reports Interface"); the Unreal wrappers expose reading a user's active sanctions for a local user and a target, sending a player report, and sending a sanction appeal (reasons IncorrectSanction, CompromisedAccount, UnfairPunishment, AppealForForgiveness; the appeal takes a sanction reference id). The local user must be authenticated. | https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineServicesEOSGS/IPlayerSanctions ; https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineServicesEOSGS/IPlayerReports |
| The docs state no rate limit for these endpoints. | the three pages above (searched for "rate"; none) |

### 4.3 Discord

| Fact | Source |
| --- | --- |
| An HTTP interactions endpoint receives each interaction with headers `X-Signature-Ed25519` and `X-Signature-Timestamp`; verify by concatenating the timestamp and the **raw** body and checking the Ed25519 signature with the app's public key (Developer Portal); an invalid signature must be answered `401`; the app "must validate the request each time". Discord PINGs (`type: 1`) the endpoint and expects `200` with `{ "type": 1 }` and a valid `Content-Type`; Discord also sends invalid signatures on purpose and removes the endpoint URL (with an email and a System DM) if validation fails. | https://docs.discord.com/developers/interactions/overview |
| Interaction types: PING 1, APPLICATION_COMMAND 2, MESSAGE_COMPONENT 3, AUTOCOMPLETE 4, MODAL_SUBMIT 5. Callback types: PONG 1, CHANNEL_MESSAGE_WITH_SOURCE 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE 5, DEFERRED_UPDATE_MESSAGE 6, UPDATE_MESSAGE 7, MODAL 9. Ephemeral flag `1 << 6` (64). | https://docs.discord.com/developers/interactions/receiving-and-responding |
| The initial response must come within **3 seconds**; the interaction token is valid for **15 minutes** for follow-ups (`POST /webhooks/<application_id>/<token>`, `PATCH .../messages/@original`). `guild_id`; for a guild interaction `member` (with `roles`: "array of role object ids", and `permissions`); for a component `data.custom_id`. | same page; https://docs.discord.com/developers/resources/guild |
| Slash commands: registered over HTTP only; bulk overwrite `PUT /applications/{app}/guilds/{guild}/commands` with a bot token (or a client-credentials bearer token with `applications.commands.update`); names 1 to 32, descriptions 1 to 100; STRING option `min_length` and `max_length` (1 to 6000); `default_member_permissions` is a permission bit set as a string; creating is limited to 200 per day per guild. | https://docs.discord.com/developers/interactions/application-commands |
| Buttons: `custom_id` 1 to 100 characters; a link button has `url` (max 512) and no `custom_id` and sends nothing to the app; an action row holds up to 5 buttons. | https://docs.discord.com/developers/components/reference |
| **A non-application-owned webhook "cannot send interactive components"** (its `components` field is ignored unless `with_components=true`, and then only non-interactive ones); "application-owned webhooks can always send components". The webhook object's `application_id` is "the bot/OAuth2 application that created this webhook" (null for an ordinary incoming webhook). Editing a webhook message: `PATCH /webhooks/{id}/{token}/messages/{message}` with `thread_id` and `with_components`. Creating a webhook: `POST /channels/{channel}/webhooks`, needs `MANAGE_WEBHOOKS`. The existing feed's webhook (made by hand in the channel settings) is therefore **not** application-owned. | https://docs.discord.com/developers/resources/webhook |
| Interaction endpoints are not bound to the bot's global rate limit; routes have per-route limits (headers `X-RateLimit-*`, a 429 carries `retry_after`); more than 10 000 invalid requests (401, 403, 429) per 10 minutes from one IP gets the IP blocked. | https://docs.discord.com/developers/topics/rate-limits |
| The `webhook.incoming` OAuth2 scope returns a webhook object (`id`, `token`, `url`, `channel_id`) in the token response; the page does not say whether it is application-owned. | https://docs.discord.com/developers/topics/oauth2 |

## 5. Shared foundations

### 5.1 `cw.links`: "this kit id is that outside id" (core, `@experimental`)

Coop needs "report R went to Coop as job J, and is decided or not"; EOS needs "sanction group G is EOS sanction S" (to remove it later),
"this EOS report was already filed" (EOS reports have no id) and one polling cursor. One small table serves both, and any future adapter.

```ts
export const LINK_SYSTEMS = ['coop-report', 'eos-sanction', 'eos-report', 'eos-cursor'] as const; // a closed list
export type LinkSystem = (typeof LINK_SYSTEMS)[number];

export interface LinkRow {
  system: LinkSystem;
  /** A kit id or a key derived from outside data (never an outside account id): 1..128 chars of A-Z a-z 0-9 _ . : # -. */
  ref: string;
  /** The outside system's id for it (a Coop report uuid, an EOS referenceId, an ISO cursor): 1..128 chars, no whitespace. */
  external: string;
  /** One short word: 'sent', 'decided', 'active', 'removed', 'filed', 'skipped'... 1..32 chars of a-z _ . */
  state: string;
  /** Epoch ms, from the kit's clock. */
  at: number;
}

interface Chatwarden {
  links: {
    /** True when the store implements the link methods. An adapter that needs links throws RangeError at construction when false. */
    readonly supported: boolean;
    get(system: LinkSystem, ref: string): LinkRow | null;
    /** Insert or replace the row for (system, ref). Throws RangeError for a value outside the shapes above. */
    put(row: LinkRow): void;
    /** Oldest first, at most `limit` (1..500, default 100), optionally only this state. */
    list(system: LinkSystem, q?: { state?: string; limit?: number }): LinkRow[];
  };
}
```

- Store: optional methods `getLink`, `putLink`, `listLinks`, `purgeLinks(before)` (optional so a custom store written for 0.1.6 still
  type-checks; the facade's `supported` is false for it). Memory store and SQLite store implement them; the shared contract suite
  (`test/contract/`) gets a links section both pass.
- SQLite migration (number assigned at merge): `kit_links(system TEXT NOT NULL, ref TEXT NOT NULL, external TEXT NOT NULL, state TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (system, ref)) WITHOUT ROWID` and `CREATE INDEX kit_links_by_state ON kit_links (system, state, at)`.
- `purge()` deletes rows older than `retention.reportsMs` (default 90 days): the rows are ids only, and a link outlives the report it
  names by no useful time. No chat text, handle, reason or outside account id is ever written here (a test pins the value shapes).
- The `eos-report` key is `sha256(time|reporting|reported|reasonId)` as hex (a one-way hash of the outside data: the outside ids are not
  recoverable from it). The `eos-sanction` key is `<groupId>#<sha256(productUserId) first 16 hex>`: a hash of a 128-bit random id,
  so it cannot be reversed in practice.

### 5.2 `cw.sanctions.byRef(refCode)` (core, `@experimental`)

`byRef(refCode: string): PersonSanctionView | null`. A reference code is `M-` plus 5 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (the
player-quotable handle in every notice). The answer is the group's staff view with its `person`, built from the subject row only (never
an IP row), the same shape `sanctions.list` returns. Case-insensitive; a bare 5-character code is read as `M-` plus it; anything else is
`null` (never throws for a string; a non-string is a `TypeError`, as `names.check`). Revoked and ended groups are found (the code never
changes). Store: an optional `sanctionGroupByRef(refCode): string | null` that uses the existing partial unique index
`kit_sanctions_ref_code`; a store without it falls back to reading the newest 1 000 groups through `listSubjectSanctions` (documented, tested).
No migration.

### 5.3 The audit and the actor

Both rows already exist: `history.view` (target `{ type: 'sanction', ref: groupId }`) for a lookup, `suggest` and `report.decide`
(target `{ type: 'report', ref }`) for the act flow, `report.decide` for a Coop decision. No new audit action, so no change to the closed
list. The actor is `discord:<user id>` (a snowflake, so at most 28 characters) or `coop:<email>`; any character outside the audit charset
becomes `_`, the result is cut to 128, and an empty one is `coop:unknown`. The **role** recorded is the kit role the adopter's mapping
gave (Discord) or the adapter's configured role (Coop, default `moderator`; a permanent ban from Coop needs `senior`, so the
role is an option, section 8.4).

### 5.4 Secrets and logs

- Secrets are options: `botToken` (only for `registerCommands`, a one-shot script, never in the running bot), the Discord interaction token (in a
  request, used for at most one follow-up, never stored), `apiKey` and `webhookPublicKey` (Coop), `clientSecret` (EOS, exchanged for a token held in
  memory until 60 s before it expires, never written to a store), the signal secret (Coop signal, 8.7).
- Each is checked once at construction (type, length, shape), as `webhookIn` checks its secret (`RangeError`, message names the option, never the value).
- A log line is `safeWarn(logger, 'chatwarden.<event>', { op, status?, error?, count? })`: the event name, an operation name, an HTTP status or an error
  class, a count. Never a URL, header, body, token, user id, report id, subject id, chat text, handle or key.
  Events added: `chatwarden.discord_bot_failed`, `chatwarden.discord_bot_denied` (reason code: `guild`, `role`, `rate`, `off`, `claimed`),
  `chatwarden.discord_components_ignored`, `chatwarden.coop_failed`, `chatwarden.coop_callback_ignored` (reason code), `chatwarden.eos_failed`,
  `chatwarden.eos_report_skipped` (reason code, count).
- Failed attempts are retried by the same rules as the existing adapters (10 s per attempt, 1, 2, 4, 8, 16 s with plus or minus 20 percent
  jitter, a 429's `retry_after` clamped to 1 to 60 s, queue of 1 000, oldest dropped and counted). That logic is extracted once (plan task A4)
  rather than copied a third and fourth time.

### 5.5 What an adopter sees when something is off

A construction error is a `RangeError` at startup. A runtime failure never reaches the kit's own operation (every listener is fenced; every
route answers with a fixed body). `dispose()` on each adapter unsubscribes, clears timers, aborts the request in flight and drops the queue.

## 6. Discord bot

### 6.1 Shape

Two parts that meet only in the adopter's wiring:

```ts
import { discordFeed } from '@chatwarden/discord';
import { discordBot, registerCommands } from '@chatwarden/http/discord';

const bot = discordBot(cw, {
  applicationId: process.env.DISCORD_APP_ID!,
  publicKey: process.env.DISCORD_PUBLIC_KEY!,        // 64 hex characters, from the Developer Portal (not a secret)
  guildId: process.env.DISCORD_GUILD_ID!,            // the one server this kit serves; every other is refused
  roles: { moderator: ['<role id>'], senior: ['<role id>'], owner: ['<role id>'] },  // Discord role ids per kit role
  hubLink: (kind, id) => `https://mod.example.com/${kind === 'report' ? 'reports' : 'people'}/${encodeURIComponent(id)}`,
  actions: { dismiss: true, suggestion: true },      // optional: "act from Discord". Omit it and the bot only answers /chatwarden lookup
});
router.add(bot.routes);                              // POST /discord/interactions, with the rest of the kit's routes

const feed = discordFeed(cw, {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL!,      // must be an APPLICATION-OWNED webhook for buttons (6.2)
  hubLink,
  components: bot.components,                        // the buttons on a report post
});
```

`registerCommands` is a separate, one-shot function the adopter runs once (it needs the bot token, which the running server never holds):

```ts
await registerCommands({ applicationId, botToken, guildId, commands: bot.commands() });
```

### 6.2 What the webhook must be (the fact that shapes this)

The existing feed posts through a webhook made by hand in the channel's settings. Discord says such a webhook cannot send interactive
components, and ignores the buttons silently. So "act from Discord" needs the report post to come from an **application-owned** webhook:
the adopter creates the webhook with the bot (`POST /channels/{forum channel}/webhooks` with the bot token, which needs `MANAGE_WEBHOOKS`),
and passes that webhook's URL to the feed. The feed's `wait=true` answer for a message sent by an application-owned webhook should name
the application; if `components` is configured and the answer does not, the feed logs one `chatwarden.discord_components_ignored` (no
detail) and carries on posting without buttons. (UNVERIFIED: that a webhook created through the bot API is application-owned and that the
`wait=true` answer carries `application_id`. The docs support both readings; the first live run settles it, section 15.)

### 6.3 The feed side (`@chatwarden/discord`)

```ts
export type DiscordButton =
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string }
  | { type: 2; style: 5; label: string; url: string };
export interface DiscordActionRow { type: 1; components: readonly DiscordButton[] }

interface DiscordFeedOptions {
  /** @experimental Buttons for the post that announces a report. Not called for any other post. A throw, or a result that does not
   *  validate (more than 5 buttons, a label over 80 characters, a custom_id over 100, a url over 512 or not http(s)), drops the
   *  buttons for that post and logs `chatwarden.discord_link_dropped`-style (op `components`, reason `invalid`), never the post. */
  components?: (post: { kind: 'report'; reportId: string }) => readonly DiscordActionRow[] | undefined;
}
```

- A post with components is sent with `?with_components=true` and `components` in the body (other posts are byte-for-byte as today).
- The feed keeps `reportId -> { threadId, messageId }` in memory (bounded at 10 000, oldest forgotten) from the `wait=true` answer. On
  `report.closed` it edits that message with `components: []` (`PATCH /webhooks/{id}/{token}/messages/{messageId}?thread_id=...&with_components=true`).
  A restart forgets the map: the old post keeps its buttons, and a click on one is answered "already decided" (6.6). That is a documented,
  harmless gap, and there is no migration for it.
- Nothing else in the feed changes. No chat text, handle, reason or note enters any post.

### 6.4 The bot (`@chatwarden/http/discord`)

```ts
export interface DiscordBotOptions {
  applicationId: string;               // a snowflake (17 to 20 digits)
  publicKey: string;                   // 64 lowercase or uppercase hex characters: the Ed25519 public key
  guildId: string;
  roles: Partial<Record<Role, readonly string[]>>;   // at least one Discord role id overall; each a snowflake
  hubLink: (kind: 'report' | 'person', id: string) => string;
  actions?: { dismiss?: boolean; suggestion?: boolean; confirm?: boolean };   // confirm defaults true
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;    // as the staff routes
  actorOf?: (discordUserId: string) => string | undefined;          // map a Discord user to a hub login, so claims line up
  rateLimit?: NamesRateLimit;          // per Discord user, default { max: 20, windowMs: 60_000 }
  timestampToleranceMs?: number;       // default 300_000
  respondWithinMs?: number;            // default 2_500 (Discord's deadline is 3 000)
  replay?: ReplayCache;                // default new ReplayCache()
  fetch?: typeof fetch;                // for the one deferred follow-up
  clock?: Clock;
  logger?: Logger;
}
export interface DiscordBot {
  routes: RouteTable;                                  // { 'POST /discord/interactions': handler }
  components(post: { kind: 'report'; reportId: string }): readonly DiscordActionRow[] | undefined;
  commands(): readonly DiscordCommand[];
  dispose(): void;
}
export function discordBot(cw: Chatwarden, options: DiscordBotOptions): DiscordBot;
export function registerCommands(options: { applicationId: string; botToken: string; guildId: string; commands: readonly DiscordCommand[]; fetch?: typeof fetch }): Promise<{ ok: true; count: number } | { ok: false; status: number }>;
```

Construction checks everything once (ids are snowflakes; `publicKey` is 64 hex; `roles` has an id; `hubLink` is a function; `actions` booleans;
`RangeError`, message never the value). The role ids are copied: later changes to the adopter's object change nothing.

### 6.5 Wire format

**Request.** `POST /discord/interactions`, JSON, headers `x-signature-ed25519` (128 hex characters) and `x-signature-timestamp` (a decimal
string of unix seconds). The route checks, in this order, and answers every failure of steps 2 and 3 with the same `401 { "error": "unauthorized" }`:
1. `rawBody` present (else 500 and a log, as `webhookIn`) and at most 64 KiB (413).
2. Headers have the right shape, the timestamp is within `timestampToleranceMs` of the clock, and
   `crypto.verify(null, Buffer.from(timestamp + rawBody, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'))` is true (the public key is built once from
   the 32 raw bytes with the fixed SPKI prefix `302a300506032b6570032100`).
3. The signature has not been accepted before (the existing `ReplayCache`, keyed by signature).
4. Only now is the body parsed (`parseJson`, forbidden keys rejected).

The timestamp window is stricter than Discord's own text (which names none): a clock more than 5 minutes off makes the bot fail closed, as the signed
webhooks already do (an option, `timestampToleranceMs`, and open question 12).

**PING.** `{ "type": 1 }` -> `200 { "type": 1 }`, `content-type: application/json`.

**Slash command** (type 2): registered as
```json
{ "name": "chatwarden", "description": "Chatwarden moderation", "type": 1,
  "default_member_permissions": "1099511627776",
  "options": [ { "type": 1, "name": "lookup", "description": "Look up a reference code",
                 "options": [ { "type": 3, "name": "ref", "description": "The code a player quoted, like M-7K3Q9", "required": true, "min_length": 5, "max_length": 12 } ] } ] }
```
(`1099511627776` is `1 << 40`, MODERATE_MEMBERS: the command is visible by default only to members who can time out members; the adopter can change
visibility in Discord. UNVERIFIED constant, section 15. Visibility is a convenience; the role mapping is the control.)

**Lookup response** (ephemeral, no mentions):
```json
{ "type": 4, "data": { "flags": 64, "allowed_mentions": { "parse": [] },
  "content": "**M-7K3Q9** · Restrict chat · 24 hours\nRule 2 (Be kind) · Active until <t:1800086400:R>\nGiven <t:1800000000:f> · By a moderator",
  "components": [ { "type": 1, "components": [ { "type": 2, "style": 5, "label": "Open person", "url": "https://mod.example.com/people/s_..." } ] } ] } }
```
The text holds: the code, the kind label, the length (or "permanent"), the rule number and title (escaped with the feed's `safeText`), the status
(`Active until`, `Ended`, `Lifted`), the given-at time as a Discord timestamp, and the source in words (`a moderator`, `the chat filter`, `Coop`,
`the AI read`, `the API`). It holds **no** reason, actor, handle or subject id (the id appears only inside the `hubLink` URL, as in the feed). An
unknown or malformed code: `No sanction found for that code.` (the same text for both, so a probe learns nothing from the difference).

**Report-post buttons** (`bot.components`, only when `actions` is set): one row.
`[Nothing wrong here] custom_id cw1:dis:<reportId>` (style 2), `[Apply suggestion] custom_id cw1:sug:<reportId>` (style 1; present only
with `actions.suggestion`), `[Open report] url hubLink('report', id)` (style 5, always). `cw1` is the grammar version.

**Button click** (type 3) with `custom_id`:
| custom_id | Meaning | Answer |
| --- | --- | --- |
| `cw1:dis:<reportId>` | preview a dismissal | ephemeral message "Nothing wrong here? This closes the report with no action." + `[Confirm] cw1:ok:<reportId>:n` + `[Cancel] cw1:x` |
| `cw1:sug:<reportId>` | preview the profile's suggested step | ephemeral message naming the step (`Restrict chat 24 hours`, `Warning`, `Note`, `No action`), the rule (`Rule 2 (Be kind)`) and the one-line `why`; `[Confirm] cw1:ok:<reportId>:<code>` + `[Cancel]` |
| `cw1:ok:<reportId>:<code>` | confirm | `UPDATE_MESSAGE` (type 7) on the ephemeral: `Done · Restrict chat · 24 hours · M-7K3Q9` and no buttons |
| `cw1:x` | cancel | `UPDATE_MESSAGE`: `Cancelled.` and no buttons |

`<code>` is `n` (a dismissal) or `<kind>.<durationMs|p>.<rule>`, for example `chat.86400000.2`, `warning.p.2`, `ban.p.1`. A `custom_id` is at most
`cw1:ok:` (7) + 32 + `:` + 22 = 62 characters (a report id is 22 to 32 characters; a test pins the longest). It is **input**: the confirm
step re-derives everything from the stored report and the current profile and refuses when the code no longer equals the current suggestion.

**Deferred answers.** The handler races its work against `respondWithinMs`. If the work is not done, it answers `type 5` (a command; ephemeral)
or `type 6` (a component) at once, and when the work finishes sends one `PATCH https://discord.com/api/v10/webhooks/<applicationId>/<token>/messages/@original`
(`fetch` option). The interaction token is never logged and never stored. A failed follow-up is logged by class.

### 6.6 What the click does

Every step re-reads the report; nothing is trusted from an earlier message.

1. **Signature, guild, user.** `guild_id` must equal `guildId` (else ephemeral `This bot is not set up for this server.`, log `guild`). A DM or any interaction with no `member` is refused
   the same way. The Discord user id is `member.user.id`.
2. **Role.** The kit role is the highest of `roles` that intersects `member.roles` (a verified payload, so it cannot be forged by the user). No match:
   ephemeral `You do not have a moderator role for this bot.` (log `role`; role names and ids are never echoed). Then the permission for the step:
   lookup `history.read`; preview `reports.read`; confirm `reports.decide` and, when the decision acts, `sanctions.apply` (and `sanctions.apply.ban_permanent` for a
   permanent ban), the exact rules `needForDecision` applies to the hub. The permission map is the staff routes' (`permissions` overrides it, validated the same way).
3. **Rate.** A `Limiter` per Discord user (default 20 per minute): over it, ephemeral `Slow down.` (log `rate`).
4. **Off.** A `cw1:` button while `actions` is not configured: ephemeral `Actions from Discord are turned off.` (log `off`).
5. **Report state.** `cw.reports.get(reportId)`. Not found, or `status !== 'open'`: ephemeral `This report was already decided (<verdict word>).` with an
   `Open report` link, and no write. This is the "decided in the hub meanwhile" case: the report, not the message, is the truth. (The feed has usually already
   removed the buttons through the `report.closed` edit; the click answer covers a restart, an edit failure and a race.)
6. **Claim.** If `cw.cases.holder(target)` is another actor, ephemeral `Another moderator has this case open.` and no write (log `claimed`). Discord never takes a case over
   (`claims.override` is a hub-only act). `actorOf` lets an adopter map Discord users to hub logins so a moderator's own claim does not block them.
7. **Rule.** The action rule is `suggestedRule(profile reasons, report.reportedReason, rules)`. `'uncovered'` (or none) with an acting step: ephemeral
   `This report needs a Community Rule chosen. Open it in the hub.` + the link, no write. A dismissal needs no rule.
8. **Preview** computes `cw.suggest(target, null, rule, { roomId })` and maps the outcome: `none` -> a dismissal; `note` -> verdict `noted` with one `note` action;
   `warning` -> `upheld` with one `warning`; `{ kind, durationMs }` -> `upheld` with that action. The reason stored is the fixed text
   `Profile suggestion, accepted in Discord` (a decision by suggestion has no typed reason; the dismissal stores the standard `No action needed`). Audit: `suggest`
   (required mode: a preview that cannot be recorded is not shown). `checkDurationsOffered` runs as it does for the hub.
9. **Confirm** runs the shared decision path (task A3 extracts it from `POST /reports/:id/decide`: claim gate, durations offered, `applyDecision`, `releaseWhenDone`),
   as `actor`, source `moderator`, then audits `report.decide` (best-effort once committed). A replay (a double click, the same code twice) is answered
   `Already done · ...`. `already_decided` with a different decision is answered as step 5. A store failure is `Something went wrong. Try again in the hub.` and a
   log of the class; nothing is half applied (the core's decision is one transaction).
10. **After.** `report.closed` fires, the feed posts the outcome into the thread (as it does for a hub decision) and strips the buttons.

With `actions.confirm: false` the first click runs step 9 directly after steps 1 to 8's checks (no preview message, same checks, same audit, same answer as a confirm); the default is the two-step flow.

**Idempotency.** Four layers: the interaction's id is remembered for 15 minutes (a repeated delivery of the same interaction gets the same answer class without a
write); the core's decision is idempotent by content; the report's state is re-read; the signature cache refuses a replayed request.

**Lookup flow:** steps 1 to 3, then `cw.sanctions.byRef`, then audit `history.view` (target the group, **required** mode: a lookup that cannot be recorded shows nothing,
as the staff reads do), then the answer. A refused or failed lookup writes no row.

### 6.7 What the bot never does
It never posts chat text, a handle, a reporter note, a moderator's reason or evidence; never mentions anyone (`allowed_mentions: { parse: [] }` on every
answer); never takes a case over; never bans permanently below `senior`; never acts on a report the viewer's role may not decide; never reads the gateway;
never holds a bot token; never trusts a `custom_id`.

## 7. When something is down or out of order (all three)

| Situation | Kit | Discord | Coop | EOS |
| --- | --- | --- | --- | --- |
| The outside service is down | Unaffected: every adapter is fenced and runs after the commit | Posts retry on the feed's rules; a click that cannot be answered in time is deferred, then fails with a fixed message | The report waits in the in-memory queue (1 000, oldest dropped and counted); `sweep()` at the next start sends what has no link | The push waits in the queue; a dropped one is counted; the kit's own sanction stands |
| The kit restarts | Nothing lost that was committed | The button map is forgotten: old posts keep buttons, and a click is answered from the report | The queue is lost; `sweep()` covers `catchUpMs` from the links ledger | The queue is lost; reconcile-before-create stops a duplicate on the next push; a lost revoke is a known gap (below) |
| The case was decided elsewhere first | The first decision stands | A click answers "already decided" | A late callback is acknowledged and ignored | Not applicable |
| The same event twice | Core operations are idempotent | The interaction id and the report state stop it | The core's decision is idempotent; a second report on a Coop job is the documented cost | The links ledger and the `cw_ref` metadata stop a second sanction |
| A hostile caller | 401, same body for every verification failure | Ed25519, window, replay, guild, role, rate | RSA verify, then effects that are idempotent | Not inbound |

A revoke that is lost to a restart between the kit's revoke and the EOS delete leaves an EOS sanction in place until it expires: the mirror is best-effort, the kit is authoritative.
A sweep that reconciles `active` links against revoked groups is listed in section 13.

## 8. Coop

### 8.1 Shape

```ts
import { coop } from '@chatwarden/http/coop';

const coopAdapter = coop(cw, {
  baseUrl: 'https://coop.example.com',                 // https, or http on localhost and 127.0.0.1 for a local Coop
  apiKey: process.env.COOP_API_KEY!,                   // X-API-KEY; a secret, never logged
  webhookPublicKey: process.env.COOP_WEBHOOK_KEY!,     // PEM, "Webhook Signature Verification Key" (Settings, API Keys)
  itemTypes: { user: '<id>', line: '<id>', report: '<id>' },   // Coop Item Type ids (created in Coop; setup.checklist() prints how)
  evidence: 'excerpt',                                 // REQUIRED, no default: 'none' | 'excerpt'
  includeNote: false,                                  // the reporter's note is player text; default false
  handles: 'hidden',                                   // 'hidden' (reporter, reported, other 1..) | 'shown'; default 'hidden'
  policies: { byReason: { harassment: '<coop policy id>' }, byRule: { 1: '<coop policy id>' } },  // outbound; a reason wins over a rule
  actions: {                                           // inbound: Coop action id -> a kit decision
    '<warn id>':       { verdict: 'upheld', kind: 'warning' },
    '<chat 24h id>':   { verdict: 'upheld', kind: 'chat', durationMs: 86_400_000 },
    '<ban 7d id>':     { verdict: 'upheld', kind: 'ban', durationMs: 7 * 86_400_000 },
    '<dismiss id>':    { verdict: 'no_action' },
    '<bad faith id>':  { verdict: 'bad_faith' },
  },
  rules: { '<coop policy id>': 2 },                    // inbound: Coop policy id -> Community Rule number
  role: 'moderator',                                   // the kit role the callbacks act with; default moderator
});
router.add(coopAdapter.routes);                        // POST /coop/actions
```

```ts
export interface CoopAdapter {
  routes: RouteTable;                       // 'POST /coop/actions' (the callback), and 'POST /coop/signal' when `signal` is set (8.7)
  /** Send every open report from the last `catchUpMs` that has no link yet (run once at startup; also callable on a timer). */
  sweep(): Promise<{ sent: number; skipped: number; failed: number }>;
  setup: { checklist(): CoopChecklist; verify(): Promise<CoopVerification> };
  dispose(): void;
}
```

Construction subscribes to `report.created` (the adapter reads the full report through `cw.reports.get`, as `webhooksOut` does for excerpts) and nothing else.
`catchUpMs` defaults to 24 h.

### 8.2 Which side is the source of truth, and the conflict rules

**The kit.** A Coop job is a *request for a review*. The report stays `open` in the kit while the job is out (no new status; the hub is unchanged). Only the
kit writes sanctions, notices and the report's status. A Coop decision is a `cw.decide` call with `source: 'coop'`, validated, authorised and audited like any
other. Rules:

1. **First decision wins.** A report decided in the hub (or by the incoming webhook, or from Discord) before Coop's callback arrives: the callback finds
   the report closed, answers `200 { ok: true, outcome: 'ignored' }` (so Coop stops retrying), logs `chatwarden.coop_callback_ignored` reason `closed`, and applies
   nothing. The Coop job is left as it is: the documented API cannot close a job, so a reviewer may open a job whose case is already settled. The first
   decision stands and the second is dropped; the hub shows the case closed.
2. **Replays are harmless.** Coop sends no delivery id and no timestamp. A repeated callback is the same decision again; the core's decision is idempotent by
   content, so it answers a replay and applies nothing. A *different* decision for an already decided report is `already_decided`: rule 1.
3. **A decision the kit cannot apply is acknowledged, not guessed.** An unknown action id, a policy with no rule mapping when the report has no
   citable suggested rule, a `bad_faith` with no `decisionReason` to use as evidence, an action for a permanent ban when the configured role is below `senior`:
   `200 { outcome: 'ignored' }`, a reason code in the log, the report stays open for the hub. (Rejecting with a 4xx would only make Coop retry five times.)
4. **No unattended enforcement.** A callback with no `actorEmail` (a rule-triggered action) or with empty `policies` and `rules` (a strike threshold) is never applied. The kit
   sends only reported items, and the checklist tells the adopter to create the actions with strikes off; if one arrives anyway, it is ignored and logged. The kit's own
   ladder is the only strike logic.
5. **Coop's Ignore and Invalidate-reports send no callback** (per the 2026-11-09 reading of the docs; UNVERIFIED for 1.2.2, section 15). A job closed with Ignore leaves the kit
   report open: it stays in the hub's queue (nothing is lost) and a dismissal action in Coop ("Dismiss", mapped to `no_action`) is what the checklist tells reviewers to use.
6. **Coop never writes the kit's store directly.** Only the verified callback reaches `cw.decide`; the adapter has no other inbound path (the signal route, 8.7, only reads).
7. **A transient failure is a 5xx.** A store failure while applying answers `503`, so Coop retries (up to five times); the decision is atomic, so a retry is safe.

### 8.3 Outbound: a report becomes a Coop job

`POST {baseUrl}/api/v1/report`, `X-API-KEY`, one at a time per adapter, in order, on the shared retry rules (a 4xx other than 429 is final and logged `coop_failed`
with the status; a 201 is parsed for `{ reportId }`). Before sending, `cw.links.get('coop-report', reportId)`; a row means it was sent. After a 201:
`links.put({ system: 'coop-report', ref: reportId, external: coopReportId, state: 'sent', at })`. A crash between the 201 and the put sends the report again at the next
`sweep()`; Coop treats a second report about the same item as another report on the job (its "number of reports"), which is the mild, documented cost.

```json
{
  "reporter": { "kind": "user", "typeId": "<itemTypes.user>", "id": "<reporter subject>" },
  "reportedAt": "2026-11-12T10:30:00.000Z",
  "reportedForReason": { "policyId": "<policies.byReason[reportedReason] or byRule[rule]>", "reason": "<the note, only when includeNote, cut to 500>" },
  "reportedItem": {
    "id": "<kit report id>", "typeId": "<itemTypes.report>",
    "data": { "category": "harassment", "reportedReason": "harassment", "rule": 2, "aiSeverity": 72, "room": "tag=value,tag2=value2",
              "creator": { "id": "<reported subject>", "typeId": "<itemTypes.user>" } }
  },
  "reportedItemThread": [
    { "id": "<line id>", "typeId": "<itemTypes.line>", "data": { "text": "zorbak vlemmo", "author": "reported", "datetime": "2026-11-12T10:29:41.000Z" } }
  ],
  "reportedItemsInThread": [ { "id": "<line id>", "typeId": "<itemTypes.line>" } ]
}
```

- **The item is the report**, with the kit report id as its Coop id, so every callback names exactly one kit report (`item.id`). A line is not used as the item, because
  a person-level one-tap report has no line and two reports can name one line.
- `evidence: 'none'` sends `reportedItemThread` and `reportedItemsInThread` as absent; the job then holds the category, rule, severity and room tags only. `'excerpt'` sends the
  report's excerpt lines, **including blocked lines' original text** (they are the evidence), labelled by role: `reporter`, `reported`, `other 1`, `other 2`... Handles only when `handles: 'shown'`.
  `reportedItemsInThread` is the reported line when the report names one.
- Subject ids (`reporter.id`, `creator.id`) are the kit's staff refs, opaque, never a hash of an account. They let Coop group a person's items; they identify no one outside the kit.
- `aiSeverity` is present only when the adopter passed the optional `aiSeverity(report)` hook (the kit's own AI read, 0 to 100, K3c). A throw drops the field, not the report.
- `room` is the room's own tags as `key=value` pairs (the adopter's strings, as in `report.created.roomTags`), cut to 200 characters. No room id.
- `csam` is never set. The kit does not detect it; Coop's own pipelines do.
- Field names in `data` must match the item type the adopter created: `setup.checklist()` prints the exact schema (below). UNVERIFIED: that `creator` is honoured as a relation field
  and that `datetime` is the ordering key's name; the local end-to-end settles both (section 15).

### 8.4 Inbound: a decision becomes `cw.decide`

`POST /coop/actions`, one URL for every action. Steps, each failing closed:
1. Body cap 64 KiB (413). `rawBody` required.
2. **Verify** the `coop-signature` header (base64, at most 1 024 characters) over the **raw** body with `webhookPublicKey`:
   `crypto.verify('sha256', Buffer.from(rawBody, 'utf8'), publicKey, Buffer.from(sig, 'base64'))` (RSA PKCS#1 v1.5). Every failure is the same `401 { error: 'unauthorized' }`.
   The docs' two examples differ (the Partial Items page shows `t=<timestamp>,v1=<signature>`), so the verifier also accepts that shape: it takes the `v1` value and tries the body, then
   `<t>.<body>`; either is accepted only if it verifies. (UNVERIFIED which Coop 1.2.2 sends; the harmless extra branch is the hedge.)
3. Optional `callbackAuth: { header, value }` is compared in constant time as well (Coop can send configured auth headers on every callback).
4. Parse, then check the shape: `item.id` (the report id), `action.id`, `policies[]`, `actorEmail`.
5. No `actorEmail`, or empty `policies` and `rules` together: ignore (rule 4).
6. `cw.reports.get(item.id)`: unknown -> `200 ignored` (reason `unknown_item`); not open -> `200 ignored` (reason `closed`).
7. `actions[action.id]`: unknown -> `200 ignored` (reason `unknown_action`).
8. Rule: the first of `policies[].id` that `rules` maps and the kit can cite; else `suggestedRule(...)`; else for a verdict that needs one, ignore (`no_rule`). A `no_action` needs none.
9. Build the decision (`verdict`, one action on the report's `targetPerson`, `reason` = `decisionReason` or `actorNote` or `Decided in Coop`, cut to 500; `evidence` = the same text for `bad_faith`).
   Authorise as the configured `role` with `needForDecision` and the permission map, `checkDurationsOffered`, no claim gate (a Coop moderator is not a hub session; as the incoming webhook, it
   never holds a claim, and when it decides the person's last open report it releases whoever held the case).
10. `cw.decide({ ..., actor: 'coop:<email>', source: 'coop' })`, audit `report.decide` (actor, the configured role, best-effort), `links.put(state: 'decided')`.
11. Answer `200 { ok: true, outcome: 'applied' | 'replay' | 'ignored' }`. Nothing else in the body.

The kit never forwards the callback body anywhere; `actorNote` and `decisionReason` are staff text and are stored only as the decision's private reason.

### 8.5 Rules sync, setup and verify

Coop documents no write API for policies, actions or item types (they are read-only over the API). So `setup.checklist()` returns a structure (and a `toText()`) listing what the adopter
creates in Coop by hand: the three item types and their fields; one policy per Community Rule (name and `policyText` from `cw.rules`); the custom actions to create, each with the callback URL and
"user strikes off"; and a line saying not to use Ignore. `setup.verify()` does three read-only GETs (`/api/v1/policies`, `/actions`, `/item_types`) and reports which configured ids exist, and which
`itemTypes` have the expected field names. It writes nothing anywhere.

### 8.6 The AI read, level one: severity in the item
The kit's AI read (K3c, not on `main` today) runs on the kit side as it does for the hub. Its severity rides in `reportedItem.data.aiSeverity`; a Coop routing rule can sort a job into a queue by that
field. This needs no Coop plugin and works the day the AI read ships.

### 8.7 The AI read, level two: a Coop signal (corrects the 2026-11-09 note)
The 2026-11-09 design said no signal was possible because Coop signals run on submitted items. Coop now documents custom integrations (section 4.1): a plugin can add a signal that "appears in the rule
builder like built-in signals", can ask for the parent and thread, and returns a number. The kit submits **only reported items**, never live chat, so a signal on them is not "AI on live chat" (a product
non-goal). The design:

- `coop(cw, { signal: { secret, read } })` adds `POST /coop/signal`: body `{ lines: [{ label, text }], item?: { text } }` (at most 50 lines, each cut to 400 characters, 64 KiB), signed with the kit's
  existing scheme (`x-chatwarden-timestamp`, `x-chatwarden-signature`, 5 minute window, replay cache; the plugin implements the 12 lines of HMAC). `read(lines)` is the adopter's wiring to the K3c
  read (a function, so this task does not depend on its API); the answer is `{ severity: 0..100 }`. A `read` that throws or exceeds 8 s is `503` with no body. The adopter's AI cost caps apply inside `read`.
  No identifier is in the request or the answer. Off unless `signal` is passed.
- `examples/coop-signal/` is a copy-in Coop plugin (about 120 lines): a manifest (`CHATWARDEN_AI_READ`), a config form (kit URL, secret), one numeric signal that asks for the thread
  (`contextNeeds: { includeThread: true, maxThreadMessages: 20 }`), posts to the kit and returns the score. An adopter lists it by local path in Coop's `integrations.config.json`
  (documented: "for local development like a local package, use a path relative to the config file"). It is **not** published to npm in this release (ruling 1, and Coop's own example is a separate repo);
  the owner may publish it later from a separate repository. UNVERIFIED: the plugin types package name (the docs say `@roostorg/coop-types`, the example imports `@roostorg/types`) and whether a report job
  evaluates signals at routing time; both are checked in the e2e (section 15). Until K3c merges, a scripted `read` stands in and the example is documented as such.

## 9. EOS

### 9.1 What EOS's API allows (and so what is in scope)

- **Sanctions can be pushed and removed from a trusted server**: create, patch, delete, query, with a `referenceId` EOS assigns. Good: kit sanctions map onto it.
- **Reports can be sent and found, but not listed.** `findReports` requires a reporting or a reported player id, so there is no "give me all new reports". The 2026-11-09 sketch ("EOS player reports come into kit
  reports") cannot be a global feed. It can be a poll **for the players the game knows are in play**: the adopter hands the adapter the product user ids currently in rooms, and the adapter asks for reports about
  them.
- **An EOS report has no room, no line, no report id**, and its `time` and `context` are written by the reporting client. The kit's report needs a room, two seats and server-witnessed evidence.
  So an EOS report becomes a kit report only when the adopter's server can place **both** players in the **same room** now (`seatOf`). Anything else is counted and skipped, never invented.
- The identifiers are EOS `productUserId`s, which the kit does not store (ruling 6): two adopter functions map them.

### 9.2 Shape

```ts
import { eos } from '@chatwarden/http/eos';

const eosAdapter = eos(cw, {
  deploymentId: process.env.EOS_DEPLOYMENT_ID!,
  clientId: process.env.EOS_CLIENT_ID!,
  clientSecret: process.env.EOS_CLIENT_SECRET!,       // a secret, never logged
  sanctions: {
    productUserIdsOf: async (subject, aliases) => lookupMyAccounts(subject, aliases),   // the ADOPTER's map; the kit stores no product user id
    actions: { chat: 'chatwarden-chat', area: 'chatwarden-area', ban: 'chatwarden-ban' },   // EOS action strings (A-Z a-z 0-9 _ -, 1..64); the three restrictive kinds
    // warning?: 'chatwarden-warning'   // off unless named
    justification: 'ref',                              // 'ref' (default): "Chatwarden M-7K3Q9, Rule 2"; 'reason' sends the moderator's private reason (off by default)
    includeAutomatic: false,                           // the 30 minute automatic chat timeouts; default false
  },
  reports: {
    seatOf: async (productUserId) => myServer.seatFor(productUserId),   // { roomId, seatId } | null, from the ADOPTER's own session table
    players: () => myServer.productUserIdsInRooms(),                    // who to ask about, this poll
    reasons: { 1: 'cheating', 2: 'cheating', 3: 'other', 4: 'harassment', 5: 'spam', 6: 'spam', 7: 'other' },   // the defaults; map to your reasons' ids
    pollMs: 60_000,                                                     // for start(); pollReports() is the unit
  },
});
```

```ts
export interface EosAdapter {
  /** One pass over `reports.players()`: find reports about them since the cursor, file the ones both of whose players are seated together. */
  pollReports(): Promise<{ seen: number; filed: number; skipped: Record<string, number>; refused: Record<string, number> }>;
  start(): void;        // pollReports() every pollMs on a timer that does not keep the process alive; stop() or dispose() ends it
  stop(): void;
  dispose(): void;      // unsubscribe, clear timers, abort in flight, drop the queue
}
```

`sanctions` and `reports` are each optional and independent: an adopter can run either one. Construction subscribes to `sanction.applied` and `sanction.revoked` (and `auto.restricted` only with `includeAutomatic`).

### 9.3 Push: a kit sanction becomes an EOS sanction

On `sanction.applied` (kinds named in `sanctions.actions`; a `note` is never pushed; a `warning` only when it has an action name), queued per adapter, in order:
1. `subjects = [canonical, ...aliases]`; `ids = await productUserIdsOf(canonical, aliases)` (a throw or an empty list logs `chatwarden.eos_failed` op `resolve` and ends).
2. For each id: key `groupId#sha256(id)[0..16]`. If `cw.links.get('eos-sanction', key)` exists, skip (already pushed).
3. **Reconcile before create**: `GET /sanctions/v1/{deploymentId}/users/{id}` and look for a sanction whose `metadata.cw_ref` equals the refCode: if found, record the link and skip.
   This closes the crash window between EOS's answer and our link write, so a retry cannot create a second sanction. (Needs the client policy action `findSanctionsForAnyUser`.)
4. `POST /sanctions/v1/{deploymentId}/sanctions` with
   ```json
   [ { "productUserId": "<id>", "action": "chatwarden-chat", "justification": "Chatwarden M-7K3Q9, Rule 2", "source": "chatwarden",
       "duration": 86400, "pending": false, "automated": false, "tags": ["cw", "rule2"], "metadata": { "cw_ref": "M-7K3Q9", "cw_rule": "2" } } ]
   ```
   `duration` is seconds: `max(1, round((until - now) / 1000))`; permanent is `0` (UNVERIFIED: that `0` means permanent on create; the page says so for the patch of a pending sanction, section 15).
   `source` is `chatwarden` (2 to 64 characters), `automated` is the event's, tags are `cw` and `rule<n>` (at most 16 characters each). `justification: 'reason'` would send the private reason; the default sends none.
5. On 200, `links.put({ system: 'eos-sanction', ref: key, external: referenceId, state: 'active' })`.

On `sanction.revoked`: the adapter resolves the same product user ids again, derives the same keys, and for each key that has a link in state `active` sends `DELETE /sanctions/v1/{deploymentId}/sanctions` with
`{ "referenceIds": ["<id>"], "justification": "Lifted: M-7K3Q9" }` (204), `links.put(state: 'removed')`. A sanction that ended on its own needs nothing: EOS expires it by `duration`.

A push never changes the kit's own enforcement: the event fires after the sanction committed, the adapter is fenced, and an EOS outage only delays or drops the mirror (logged by class and count).

**Token.** `POST /auth/v1/oauth/token` (Basic auth, `grant_type=client_credentials`, `deployment_id`), cached until 60 s before `expires_in`; one 401 refreshes and retries once; the secret is built into the
header per request and is not logged or stored.

### 9.4 Pull: an EOS report becomes a kit report

`pollReports()`:
1. `ids = await reports.players()` (deduplicated, at most 500), in batches of 20 (`reportedPlayerId` repeated; UNVERIFIED maximum per request, configurable `batch`).
2. `GET /player-reports/v1/report/{deploymentId}?reportedPlayerId=...&startTime=<cursor - 10 min>&pagination=true&limit=50&order=time:asc`, paged until a short page.
3. For each report: `key = sha256(time|reportingPlayerId|reportedPlayerId|reasonId)`; `links.get('eos-report', key)` present -> skip (the 10 minute overlap and the client-written `time` make dedupe by key the
   only safe rule). Otherwise `seatOf(reporting)` and `seatOf(reported)`: either null, or different rooms -> `links.put(state: 'skipped')`, count `unseated`. Else
   `cw.reports.submit({ roomId, reporterSeat, targetSeat, reason: reasons[reasonId] ?? null, note: message cut to 500, lineId? })`, where `lineId` is read from `context` **only if** it parses as JSON with a
   string `lineId` of at most 64 characters (everything else in `context` is ignored: it is client-written).
   The kit's own checks decide: the 10-per-day cap, suspension, an unknown reason, a target that is not seated, a line outside the evidence window. A refusal is counted by its code (`refused.rate`, ...)
   and `links.put(state: 'skipped')`; a `ReportResult` ok is `links.put(state: 'filed', external: reportId)`.
4. The cursor `links.put('eos-cursor', 'reports', external: <newest report time seen>)`, not past now plus 1 minute (a client cannot push the cursor into the future).

The report's `createdAt` is the kit's clock, never EOS's `time`. The reporter's note is EOS's `message`, handled like any reporter note (staff only, never in an event, never sent to Discord).

### 9.5 What stays on the client
Reading a player's active sanctions (to show "you are sanctioned" or to enforce at login) and filing a report from the game UI are EOS SDK calls the **game client** makes; they need the local user to
be authenticated and are not the kit's. The kit's own notices still tell the player the rule and the reference code, as today. Appeals through EOS (`POST .../appeals`, status `OPEN`) are not read in this release.

## 10. Security

- **Every inbound request is verified before it is parsed**, over the exact bytes (`rawBody`): Discord by Ed25519 (`node:crypto` over `timestamp + body`), Coop by RSA PKCS#1 v1.5 SHA-256 (public key only), the
  Coop signal by the kit's HMAC. A missing `rawBody` is a 500 and a log (a setup error, never a pass). Every verification failure in a route is the **same** 401 body, whatever the cause.
- **Replay.** Discord: the signature cache plus the 5 minute window plus idempotent effects. Coop: the body-only signature carries no time, so replay safety is by effect (the core's idempotent decision, the closed
  report), not by freshness; the adapter says so in its README. Signal: timestamp window and cache.
- **Roles.** Discord roles come from a signed payload and map to the kit's three roles; the permission map is shared with the staff routes, so a change of `permissions` applies to both. The Coop adapter acts as
  one configured role. Nothing in a request, a `custom_id` or a Coop `custom` object can choose a role, actor or source.
- **No identifier or text leaves except where ruled.** Discord posts: unchanged. Coop: only per ruling 5. EOS: ids are the adopter's, justification fixed. Nothing is ever sent to a player.
- **Untrusted input everywhere**: a Discord `custom_id`, option value and role list; a Coop body (any field may be missing, mistyped or huge); an EOS report's `message`, `context`, `time` and ids (all
  client-written). Each is length-capped, shape-checked and rendered inert (escaped by `safeText`, no mentions, no markdown, no links except the adopter's `hubLink`).
- **SSRF.** Outbound hosts are fixed by the adopter at construction: `baseUrl` (Coop; https, or http on localhost and 127.0.0.1, no credentials, redirects not followed), `https://api.epicgames.dev` (EOS; an
  option only for tests), `discord.com` for the follow-up (the host is fixed; only the application id and token vary, both checked by shape).
- **Rate limits.** Per-Discord-user limiter on the interactions route; the signal route has its own limiter. Failed signatures are not throttled in the route (as `webhookIn`): rate-limit at the edge, and
  Discord's own invalid-request ceiling (10 000 per 10 minutes per IP) is a reason to.
- **Audit.** Every lookup and every act is a row with the actor and the role. Refusals (wrong guild, no role, rate, claimed, off) are **logged** with a reason code, not audited (the audit list is closed and
  holds successful staff acts).
- **Secrets** (5.4) and **logs**: event names and error classes only.

## 11. Tests that pin it

Each integration has a fake that implements the documented wire format strictly (a fake that accepts anything proves nothing), and every test injects the clock, `fetch`, `random` and `logger`.

**Fakes (new test helpers):**
- `fakeDiscordClient` (`packages/http/test/discord-world.ts`): generates an Ed25519 key pair with `node:crypto`; builds and signs interactions (`ping`, `lookup`, `click`) with a controllable timestamp;
  returns the response body; a fake Discord REST (`PATCH @original`, `PUT commands`) that records calls and can answer 429 or 5xx.
- `fakeCoop` (`packages/http/test/coop-world.ts`): a `fetch` that validates `X-API-KEY`, validates the `POST /api/v1/report` body against the documented schema (required fields, types, `reportedAt` ISO), answers
  201 `{ reportId }` or a scripted 400, 401, 429, 5xx; `GET /policies`, `/actions`, `/item_types`; and a callback maker that signs a body with a generated RSA key (`createSign('RSA-SHA256')`) in both header shapes.
- `fakeEos` (`packages/http/test/eos-world.ts`): the token endpoint (Basic auth checked, `expires_in`), `POST/GET/DELETE /sanctions/v1/{deployment}/sanctions` with the documented limits enforced (action charset and
  length, justification 1..2048, source 2..64, tag 16, metadata 25/64/128), `GET .../users/{id}` including `metadata`, `GET /player-reports/v1/report/{deployment}` that **refuses both player filters empty**, paging, `startTime`.
- The existing `world.ts` (real core over `MemoryStore`, a fake clock) for the kit side.

**Test files and the names that matter** (the plan lists them per task):
- `core`: `byRef finds a live, an ended and a lifted group; a bare code and lower case; garbage and a non-string; a store without the method falls back`; `links: get, put (upsert), list by state and limit; value shapes refused; purge by retention; supported is false for a store without the methods`; both stores pass the contract.
- `discord feed`: `components go only on the report post, with with_components; an invalid set drops the buttons and not the post; report.closed edits the post to no components; a restart loses the map and posts nothing wrong; every other post is byte-identical to today`.
- `discord bot`: signature (wrong key, flipped body byte, stale timestamp, future timestamp, missing header, uppercase hex, replay: every one the same 401); ping; the wrong guild; a DM; no role; role mapping (highest wins; an unlisted role is nothing); rate; lookup (live, ended, lifted, unknown, malformed, not leaking a reason, actor, handle or subject id; audit row `history.view`; an audit failure shows nothing); the whole act matrix (dismiss and suggestion, preview and confirm, every outcome kind, `uncovered` refused, permanent ban refused below `senior`, a claim held by another refused, `actorOf`); the report decided in the hub between preview and confirm; a double click; two confirms racing; a `custom_id` forged to a different action refused; deferred response when the work is slow; `allowed_mentions` on every answer; logs hold no id, token or text.
- `coop`: outbound (the body against the schema for every `evidence`, `includeNote`, `handles` mix; a 400 is final; a 429 honours `retry_after`; a crash and `sweep()` send once); inbound (both signature shapes; wrong key; flipped byte; each of the seven rules in 8.2; replay; the Partial `t=...,v1=...` header; the role gate for a permanent ban; `bad_faith` needs a reason; a store failure is 503); setup checklist and verify; signal route (signature, cap, `read` throwing); the example plugin against a scripted harness.
- `eos`: token (cache, refresh once on 401, never logged); push (each kind; permanent; automatic off and on; warning off and on; reconcile-before-create finds the earlier sanction after a simulated crash; a revoke removes; a revoke before the create finished; two accounts for one person; a failing `productUserIdsOf`); poll (the both-empty-filter rule respected, batching, paging, dedupe across the overlap, a client `time` in the future and the past, `unseated` and `different room` skipped, a `context` with a hostile `lineId`, the kit's refusals counted, the cursor never beyond now plus a minute).
- `cross`: `logs hold event names and error classes only` (seed a distinctive key, token, id and text in every option and body; scan every log line); `construction errors never echo a value`; `nothing happens at import`; `dispose clears every timer`; `no new export from the http root` (`exports.test.ts`); `the subpaths resolve under ESM and CommonJS` (`check-pack`, `cjs-types`).

**Live checks (manual, owner-approved, not CI):** one run against a real Discord guild (commands registered, a ping accepted, a lookup, a dismiss), one against a local Coop (`docker compose`, one report out, one decision back), one against an EOS dev
sandbox deployment (a sanction pushed and removed, a report found). They settle the UNVERIFIED items in section 15.

## 12. Risks

- **Discord's webhook ownership.** If a bot-created webhook turns out not to be application-owned, the buttons never appear. The feed detects and logs it; the fallback (post through `POST /channels/{id}/messages` with a bot token)
  is a second transport and is not built here (open question 1). Mitigation: the first live check, and the README's setup is written from that run.
- **The bot adds a public endpoint.** Mitigation: verify-before-parse, the same 401 for every failure, a body cap, a per-user limiter, edge rate limiting advised, and Discord's own routine bad-signature probes keep the verifier honest (a bot that
  fails them loses its URL, which is a loud failure, not a silent one).
- **A click on a stale post.** A restart forgets which messages carry buttons. The answer to a click is always computed from the report (6.6 step 5), so the worst case is a stale button, not a wrong decision.
- **Coop jobs that never close.** The documented API cannot close a job, so a hub decision leaves a job in Coop. Mitigation: first decision wins and a late callback is acknowledged, not applied; the checklist says so; open question 5.
- **Coop's signature has no timestamp.** Replays are harmless by construction (idempotent decision, closed report) but a captured callback stays "valid" forever; the key rotation in Coop's settings is the remedy and is in the README.
- **Chat text in Coop.** It is the one place the kit sends text out. It is opt-in with no default, and it is the adopter's own Coop.
- **Spec drift.** Coop is at 1.2.x and moving ("features and docs expected to change"); the Coop docs disagree with themselves on the signature header and the plugin types package. Mitigation: fixtures are copied from the docs with their URLs, the verifier hedges, `setup.verify()` is a live self-check, and the e2e is a release gate for the Coop group.
- **EOS reports are weak evidence.** A poll finds reports only about players the adopter names, with a client-written time, no id and no room. We file only what the kit's own checks accept, count the rest, and never trust `context`. An adopter who expects "all my EOS reports in the hub" will be disappointed: the README says what it does and does not do.
- **EOS permanence and rate limits are undocumented.** `duration: 0` for permanent, the batch size for `reportedPlayerId` and the rate limits are not stated; the adapter keeps batches small, backs off on 429 and 5xx, and the sandbox run checks them.
- **`http` grows.** Three Node-only subpaths, none loaded unless imported. The root export test pins that the root is unchanged and `sideEffects: false` holds.
- **One migration shared by two integrations.** A bug in `cw.links` would block both. It is small, additive, covered by the contract suite on both stores, and the Discord bot does not depend on it.

## 13. Not in this release

- A Discord gateway bot; slash commands beyond `lookup`; modals for a typed reason (the confirm step uses the fixed reason); select menus for rule or length; context-menu commands; a ban from Discord below the hub's rules (it follows them).
- A bot-token message transport for the feed (only if an application-owned webhook cannot be had).
- Looking up a report or a `Case XXXXX` label from Discord (a reference code only; the thread is the case).
- A reconcile sweep for EOS (find `active` links whose group was revoked while the adapter was down, and delete them); the lost-revoke gap is documented instead.
- Pulling sanctions made in the EOS Developer Portal into the kit (`GET /sanctions/v1/sync`), EOS appeals (`POST/GET .../appeals`), EOS anti-cheat, EOS voice.
- Coop appeals (`/api/v1/report/appeal`, the Appeal Decision Callback), the Partial Items endpoint, `items/async` (proactive rules on live chat: a non-goal), closing Coop jobs from the kit, mirroring a hub decision into Coop.
- Publishing the Coop plugin to npm (the owner can do it from a separate repository later), and any new `@chatwarden/*` package.
- A `chatwarden coop setup` CLI (K4b owns the CLI; `setup.checklist()` and `verify()` are the functions it will call).
- Hub changes: no new chip for "out for review in Coop" or "mirrored to EOS" (the clean-core rule; the audit and the logs carry it).
- Other platforms (PlayFab, Steam, Xbox): on request only.

## 14. Rollout, docs and owner actions

**Groups ship independently** (the plan's groups A to R): the Discord bot needs only `byRef` (no migration) and the feed hook; Coop and EOS need `cw.links` (the migration). Each group's tasks end with its README
section and its tests. One changeset per release, patch, in the fixed group; first line names the integration(s) it carries; the subpaths are named so `scripts/changelog.test.ts` passes. `@experimental` until 0.2 on every new name.

**Peer floors.** `@chatwarden/http` peers on core `^<the release that ships byRef and links>`, raised by hand (RELEASING.md, "When a peer floor must rise"), with the matching `scripts/manifests.test.ts` expectation. `@chatwarden/discord` keeps `^0.1.0` on core (the
feed hook uses no new core name). `store-memory` and `store-sqlite` rise only in the release that carries `cw.links` (they implement the new store methods), as the other store changes did.

**No new package, so the OIDC publish path is unchanged and the owner has no first-publish to do.**

**Owner actions (outward, one-time, none of them is code):**
1. *Discord.* Create a Discord application in the Developer Portal; copy the application id and the public key. Create the bot, invite it to the moderation server with `bot` and `applications.commands`, with `MANAGE_WEBHOOKS` on the forum channel. Create the application-owned webhook with the bot (one `POST /channels/{forum}/webhooks`, the README gives the exact `curl`), and keep the bot token offline (it is used only by `registerCommands` and that one call). Deploy the route, then paste its URL as the **Interactions Endpoint URL** (Discord PINGs it when you save). Copy the moderator, senior and owner role ids. Run `registerCommands` once.
2. *Coop.* Stand up a Coop (the docs' Docker Compose route). In it: create the three item types, the policies from `setup.checklist()`, the custom actions with the callback URL and strikes off; copy the API key and the Webhook Signature Verification Key. Run `setup.verify()`.
3. *EOS.* In the Developer Portal, for the product and deployment: create client credentials whose client policy allows `sanctions:createSanction`, `sanctions:deleteSanction`, `sanctions:findSanctionsForAnyUser` and `playerreports:findReportsForAnyUser`; decide the sanction action strings. Provide the two functions (`productUserIdsOf`, `seatOf`) from your own session table.
4. *Live checks.* Approve one live run per integration against a throwaway guild, a local Coop and an EOS sandbox deployment (the plan's last task of each group), to settle section 15.
5. *Release.* Merge, then tag, as every release (RELEASING.md): the maintainer's call.

## 15. Facts to verify live (UNVERIFIED above)

| # | Claim | How it is settled |
| --- | --- | --- |
| 1 | A webhook created with the bot is application-owned and sends buttons; the `wait=true` answer carries `application_id` | the Discord live run (post with `components`, read the answer) |
| 2 | `1 << 40` is `MODERATE_MEMBERS` | the Discord permissions page, at the first Discord task |
| 3 | Coop 1.2.2's signature header shape (`base64` alone, or `t=...,v1=...`) and what the `v1` signs | the local Coop e2e; the verifier accepts both until then |
| 4 | Coop's Ignore, Invalidate-reports and Move send no callback | the local Coop e2e |
| 5 | A reported item carries `creator` and `datetime` as the item type fields Coop expects | the local Coop e2e (`setup.verify()` compares field names) |
| 6 | A report job evaluates signals at routing time; the plugin types package name (`@roostorg/coop-types` or `@roostorg/types`) | the local Coop e2e with the example plugin |
| 7 | EOS `duration: 0` is permanent on create; the `reportedPlayerId` batch limit; EOS Web API rate limits | the EOS sandbox run |

## 16. Plan coverage
Section 6 to plan group D, section 8 to group C, section 9 to group E, section 5 to group A, sections 10 to 12 to the per-task tests and the review focus, section 14 to group R.

## 17. Open questions

Each has a recommendation; the controller rules.

1. **Where the Discord bot lives and what posts the buttons.** *Recommended: `@chatwarden/http/discord` with a generic `components` hook in `@chatwarden/discord` and an application-owned webhook.* The alternative (the bot posts through a bot token) is a second transport; build it only if live check 1 fails.
2. **Which buttons on the report post.** *Recommended: "Nothing wrong here" and "Apply suggestion", each with a confirm step, plus the "Open report" link.* Alternatives: link buttons only (no act); a full decision modal (rule, length, reason). The recommended pair is the hub's one-click path; anything richer is the hub's job ("power behind one door").
3. **Should the confirm step be optional.** *Recommended: on by default (`actions.confirm: true`); an adopter may turn it off.* A shared channel makes a mis-click likely, and a decision has no server-side undo yet (parked follow-up).
4. **What `lookup` accepts.** *Recommended: a reference code only.* A `Case XXXXX` label is random and mapped to a thread, not a decision; a report id is not something a player quotes.
5. **Coop jobs that the hub closed first.** *Recommended: leave them; document it.* Alternative: have the adapter resubmit the item with a "closed" field so a routing rule can drop it (an unverified use of `items/async`).
6. **Coop signal plugin distribution.** *Recommended: a copy-in example in this repo now; the owner may publish it from a separate repository later.* A new `@chatwarden/coop-signal` package needs a first manual publish and Coop's own example lives in its own repository.
7. **AI severity in Coop.** *Recommended: level one (the number in the item) in this release, level two (the signal) only after the K3c read exists, wired through the `read` function.*
8. **EOS reports for players not in a room.** *Recommended: skip and count them.* The alternative, a "platform report" with no room and no evidence, would give moderators a case they cannot verify and breaks the kit's "server-witnessed evidence" rule.
9. **Push warnings and automatic timeouts to EOS.** *Recommended: no by default (both are options).* A warning has no end; the automatic timeouts are 30 minutes and noisy.
10. **EOS justification text.** *Recommended: the reference code and rule only; the moderator's reason is opt-in (`'reason'`).* The Developer Portal is wider than the hub's staff.
11. **Migration for `cw.links`, or reuse the 24 hour `webhookKeys` table.** *Recommended: the migration.* `webhookKeys` expires in a day and a crash leaves a key pending; Coop and EOS need a durable ledger.
12. **The Discord timestamp window.** *Recommended: 5 minutes, configurable.* Discord names none; a window blunts replay but makes a skewed clock fail closed.
13. **Pulling sanctions made in the EOS portal into the kit (`/sanctions/v1/sync`).** *Recommended: not now.* It needs a story for the kit's ladder and notices that K10 (appeals) should shape.
14. **Audit refused Discord attempts.** *Recommended: log by reason code, do not audit.* The audit list is closed and records successful staff acts; a flood of denied clicks would drown it.
15. **Make a published `@chatwarden/discord` peer on a newer core.** *Recommended: no; the feed hook needs no new core name.*

## 18. Rulings

*(To be filled by the controller when the questions above are answered.)*

## Rulings (2026-11-12, controller, under the owner's "go" on the roadmap order)
All fifteen open questions take the recommendation, with one change: (7) the AI read now exists (0.1.7, AI levels 1 and 2, merged), so the Coop signal route may use the stored read's severity from the start; the number also rides in the item. The rest as recommended: the bot at `@chatwarden/http/discord` with a `components` hook in the feed and an application-owned webhook (a bot-token transport only if live check 1 fails); "Nothing wrong here" and "Apply suggestion" with a confirm step on by default plus an "Open report" link; `lookup` takes reference codes only; Coop jobs the hub closed first are left and a late callback is acknowledged without applying; the Coop plugin is a copy-in example; EOS reports for players not in a room are skipped and counted; warnings and automatic timeouts are not pushed to EOS by default; EOS justification carries reference code and rule only; `cw.links` gets its own additive migration (numbered at build time after the migrations already shipped); a 5-minute Discord timestamp window; no pull of portal-made EOS sanctions yet; refused Discord attempts are logged by reason code, not audited; `@chatwarden/discord`'s core floor stays.
Each integration ships independently; the owner's one-time setup per platform is listed above and none blocks building and testing against fakes.
