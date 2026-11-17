---
status: draft, awaiting owner review of the Rulings (section 16)
updated: 2026-11-17
release: 0.2.0 (the release where @experimental settles; there are no adopters yet, so nothing here is held back for compatibility)
audit: docs/design/2026-11-17-moderation-coverage-audit.md, gaps G4, G9, G10, G11, G12, G16, G17, G18
---

# Any server, many rooms, more languages

Three themes of 0.2.0, built as themed chunks on one branch. This note designs them and nothing else; the other three themes (names inside
reports and the "what the player sees" preview; chat filter rules and privacy requests; the urgent lane, the desk and room tools) are
designed in parallel by others. Section 13 lists what this note needs from them and what they need from it.

- **Any server (G4, G18).** A game server in C#, Go, Rust or GDScript runs one container beside it and calls a documented HTTP API; the
  kit's pacing agrees between processes through the store.
- **Many rooms, many players (G9, G10, G11, G12).** Rules per room by a tag, a moderator limited to a set of rooms, block, phrase-only
  chat for young players, reserved names and clan names.
- **More languages (G16, G17).** Spanish and Portuguese words for the player and the hub (machine-drafted, marked as such), and matching
  for scripts written without spaces.

Rules this note keeps from the audit: text chat only (no images, media or voice); everything new is off until an owner turns it on; the
core UI stays clean and power sits behind one "advanced" door; a signal, a filter or a context never writes a sanction; the kit holds
hashes and ids, not people; a player is always told; nothing in this note adds a published package.

## 1. Why

**G4.** The kit is a Node library plus Node-shaped adapters (`toExpress`, `toFetch`). The site FAQ says "if your server is written in
another language, there's no ready-made bridge yet", and the K4b note (`2026-11-12-k4b-adoption.md`, section 11) deferred a service mode
on purpose: it is a trusted-caller API, a new threat model, a new artifact. Unity, Godot, Unreal, Photon and most dedicated servers are
not Node, so today a large share of games cannot adopt at all. K4b's own words for the door left open: `createKit` is separate from the
framework mount, so "a future `serve` command is `createKit` plus one more route table".

**G18.** Slow mode, the burst limit and repeat refusal (0.1.8) live in one process's memory. A game with several processes and no room
affinity gets up to N times the limit (flood design 4.6). A service that fronts several game servers would hit this on day one.

**G9, G10, G11, G12.** One profile covers every room, there is no per-room strictness, no scoping of a creator's moderators, no block, no
phrase-only chat, and nothing protects staff or clan names. The audit's rows S2, S3, S6, S11, S12, L1, C8, C13 and N2.

**G16, G17.** Every player and hub word has an English catalogue and a fallback and nothing else; the corpus covers en, es and pt, but
no Spanish or Portuguese words ship, and a term in Chinese, Japanese or Thai cannot even be written (the matcher takes `[a-z]` words and
needs a space as a word edge).

## 2. Goals and non-goals

### Goals
- A non-Node game server can moderate chat with five calls (seat, check a line, report, notices, acknowledge) over a documented,
  versioned, authenticated HTTP API, with one container to run and no Node code of its own.
- The API is small, boring and stable: JSON, bearer keys, idempotent where a retry would double-count, errors the way the rest of the kit
  answers them, and it is the same decision function the Node facade uses (no second implementation of matching or pacing).
- A staff hub for that service with no extra work.
- Pacing that agrees between processes sharing one SQLite store, with no sticky routing needed for that part.
- One profile, many room kinds: a tag on a room picks a named set of chat-time rules (profanity, pace, phrases, minimum account age).
- A moderator can be limited to a set of rooms, enforced in the store reads and in every route (default-deny), never by the UI.
- A player can block another: neither sees the other's lines; the game can ask "are these two blocked?" without the kit ever listing
  people.
- A room can be phrase-only: the player picks from a list the game owns; every viewer sees it in their own language.
- A game can ask "may this clan be called that?" and "is this too close to a staff name?", and a clan can be reported through its owner.
- Spanish and Portuguese words for the player components and the hub, loaded on demand, honestly marked as machine-drafted.
- A term in Chinese, Japanese, Thai, Lao, Khmer or Burmese matches inside a run of that script without matching inside an innocent word.

### Non-goals
- No published Docker image, no registry, no image workflow (outward and permanent; the owner's go-ahead). The release ships a **recipe**.
- No new npm package. The service is a bin and a subpath of `@chatwarden/http` (K4b ruling 1 still stands).
- No engine SDKs (Unity, Godot, Unreal). A C# sample client and a `curl` script show the wire; SDKs are K14.
- No shared evidence buffer, seats, mutes cache or `rate` window across processes. Service mode is one process per room set (section 3.8).
  Only the pacer is shared.
- No player-facing routes in the service: a non-Node game draws its own report button, notices and chat. The chat box, `NoticeQueue` and
  the player routes stay a Node-side feature.
- No translation of the starter Community Rules, the profile summary or the generated code of conduct (they are the game's words).
- No Spanish or Portuguese other than the two catalogues; no German, French, Japanese in this release. No right-to-left work.
- No non-Latin *spaced* scripts (Cyrillic, Arabic, Hangul, Devanagari) in the matcher; no Chinese script conversion, pinyin or
  homophone matching; no spaced-out evasion for any script.
- No block counters, "who blocked me" views or staff views of blocks (a block is the player's own choice, and a count would be a signal
  for the signals theme to design).
- No per-context ladder, durations, reporting reasons or appeals. A context changes what happens to a line, not what happens to a person.
- No UI to edit contexts in the hub (they are declared in code).

## 3. Part A: any server

### 3.1 What ships, and where

| Piece | Where | Published? |
| --- | --- | --- |
| `serviceRoutes(cw, options)`: the `/v1` route table; `createServiceClient(options)`: a typed fetch client; `SERVICE_API_VERSION`; `SERVICE_OPENAPI` | `@chatwarden/http/service` (new subpath; browser-safe: no `node:` import except `node.ts`) | yes (inside http) |
| `chatwarden serve`: the process | `chatwarden` bin of `@chatwarden/http` (`src/cli/serve.ts`, `src/service/serve.ts`, `src/service/node.ts`) | yes |
| `chatwarden init --service`: writes the recipe | same bin | yes |
| Dockerfile, compose file, `.env.example`, profile file, curl script | `examples/service/` (private, in the repo) and, identically, written by `init --service` | no (not in the tarball) |
| C# sample client and demo | `examples/service-csharp/` (private) | no |
| Shared pacer | `@chatwarden/core` (`createSharedPacer`), `@chatwarden/store-sqlite`, `@chatwarden/store-memory` | yes |

`@chatwarden/http/service` imports only `@chatwarden/core`. The process file `serve.ts` dynamically imports the packages it needs from
the project it runs in (`@chatwarden/store-sqlite`, `@chatwarden/matcher`, `@chatwarden/profanity`, `@chatwarden/hub-element`), so none
of them becomes a hard dependency of `http`. `package.json` declares them as optional peers, and `serve` says in one line which
package is missing and the install command, exit 2.

### 3.2 API conventions (v1)

**Base and shape.** Everything is under `/v1`. Request and response bodies are JSON (`application/json`; a POST with another content
type is 400 `invalid_request`, as in the chat routes). Every response is `cache-control: no-store`, `x-content-type-options: nosniff`
and carries `chatwarden-api: 1` and `x-request-id` (the request's own `x-request-id` when it is 1..64 characters of `A-Za-z0-9_.:-`,
else 16 random hex characters; it appears in the log line and nowhere else). Errors are the kit's flat shape `{ "error": "code",
"message": "fixed text" }`, with the codes of `errors.ts`; the message never echoes input.

**Versioning.** The path carries the major version. Within `v1`, a change is additive only: new optional request fields, new response
fields, new routes, new refusal `reason` strings and new error codes. A client must ignore response fields it does not know and treat a
refusal reason it does not know as `unknown` (the chat wire already says this). Anything else is `/v2`, served beside `/v1` for at least
one minor release. `GET /v1` is the handshake:

```json
{ "api": 1, "kit": "0.2.0", "mode": "service", "processes": "single",
  "capabilities": { "phrases": true, "blocks": true, "contexts": ["kids", "ranked"], "sharedPacing": false, "matchModes": ["word", "segment", "contains"] },
  "warnings": ["synthetic_terms"] }
```

`warnings` is a list of closed codes an operator should read: `synthetic_terms` (the starter pack is in use), `pacing_per_process`
(more than the default of one process is claimed, or `sharedPacing` is off while `CHATWARDEN_PROCESSES` is above 1), `plain_http` (the
service answered a request that carried an `x-forwarded-proto: http` header; see 10). It is the "health check that says so":
`/readyz` stays the public up-or-not probe and tells nothing else.

**Authentication.** `Authorization: Bearer <key>`, a **service key**: 32 to 256 characters of `A-Za-z0-9_-.~+/=`. Keys come from
`CHATWARDEN_SERVICE_KEYS` (comma separated, one to five; two during a rotation: deploy the new key to the game servers, then remove the
old one) or from the `keys` option. The service holds the SHA-256 of each key, compares the SHA-256 of the presented key against every
configured digest with `timingSafeEqual` (all of them, so timing says nothing about which matched), and never logs, echoes or stores a
key; the log and the rate limiter carry `kid`, the first 8 hex characters of the digest. A missing, malformed or wrong key is 401
`unauthorized` with `www-authenticate: Bearer` and no hint of which. A caller that fails 20 times in a minute (counted by the socket's
`remoteAddress`, one shared bucket when the adapter gives none) gets 429 `rate_limited` for the rest of the minute, correct key or not.
There is one scope: a key may call every `/v1` route. Service keys are not staff credentials and a staff token is not a service key: the
two sets never overlap (the service refuses to start when a key equals the admin token).

The game server is the trusted party here: it says who each seat is. It sends the real client address as `who.ip` itself; the service
never reads an address from its own socket for a player and never trusts `x-forwarded-for` for one.

**Rate limit.** Per key: 3000 requests per 10 seconds by default (`rateLimit: { max, windowMs }`; a game with 1000 players chatting
once every three seconds sends about 330 a second). Over it: 429 `rate_limited` with `retry-after` in whole seconds (at least 1).
Underneath, the kit's own per-seat limits still apply and answer as refusals (`rate`, `slow_mode`, `flood`, `duplicate`), because they
are about the player, not the caller.

**Body cap.** 64 KiB (`BODY_MAX_BYTES`), read with a byte cap; over it 413 `payload_too_large`. A line is at most 2000 characters on
the wire (longer is answered `length` without asking the kit, as the chat routes do); the kit's own limit (200 by default) still decides.

**Idempotency.** `Idempotency-Key: <1..64 characters of A-Za-z0-9_.:->` on `POST .../lines`, `POST .../phrases` and `POST .../reports`,
the three calls whose retry would be judged twice (a strike, a spent rate slot, a second report). Rules:
- A key is scoped to the calling key, the method and the path. The service keeps `(kid, method, path, key)` with a SHA-256 fingerprint of
  the canonical body and the stored `(status, body)` for 10 minutes, in memory, at most 20 000 entries (the oldest go).
- Same key and same fingerprint, finished: the stored answer is returned with `idempotent-replay: true`. Nothing is run again, no rate
  slot is spent and no strike is written. A refusal (a 200 with `ok: false`) is stored too, so a retried slur is not struck twice.
- Same key, different fingerprint: 409 `idempotency_mismatch`. Same key while the first call is still running: 409 `in_progress`.
- A 5xx, a 401 and a 429 are not stored (the retry may succeed). A malformed key is 400 `invalid_idempotency_key`.
- Without the header there is no de-duplication; a retried line is judged again, and the kit's per-seat `rate` absorbs a burst of
  retries. Documented as the reason to send the header.
- The store is per process, so idempotency across several service processes needs the same call to reach the same process (3.8).

**Identifiers.** A room or seat id in a path is 1..128 characters of `A-Za-z0-9_.:@~-`; anything else is 400 `invalid_request`.
They are the game's own ids and are treated as opaque. A `who` object is `{ clientKey?: string, accountId?: string, ip?: string }`, each
1..256 characters, at least one of `clientKey` or `accountId` for a call that seats or reads a person; unknown keys are refused
(400). A **read that carries an identity is a `POST`** (notices, restriction, doors, blocks), so a raw account id or address is never
in a URL, an access log or a proxy cache.

### 3.3 Routes

All routes are under `/v1`. `who` is described above; `seat` is the game's seat id inside a room.

| Method and path | Body | 200 answer | Notes |
| --- | --- | --- | --- |
| `GET /v1` | none | the handshake above | |
| `PUT /rooms/{room}/seats/{seat}` | `{ who, handle, tags? }` | `{ ok: true, restriction: { until: number\|null, kind: "chat"\|"ban"\|"auto" } \| null }` | Seats a person (idempotent by nature: a repeat replaces). `handle` 1..64 characters, shown to moderators. `tags`: at most 8 keys, key `[a-z][a-z0-9_]{0,23}`, value 1..64 characters; `context` and `scope` are reserved (4.1, 4.2); a bad reserved value is 400. `restriction` is `cw.chat.restricted` for the seat, so the game can say "you are muted" at once. |
| `DELETE /rooms/{room}/seats/{seat}` | none | `{ ok: true }` | Empties the seat; a no-op when unknown. |
| `DELETE /rooms/{room}` | none | `{ ok: true }` | `cw.rooms.close`: seats, tags, evidence and pace state of the room go. |
| `POST /rooms/{room}/seats/{seat}/lines` | `{ text }` | `{ ok: true, line: { id, text }, hiddenFor: [seat] }` or `{ ok: false, refused: { reason, until?, byModerator?, rule?, noticeId?, retryAfterMs? } }` | The check. Idempotent with the header. `refused` is built by `refusalOf` (the chat wire's copier): only those fields, never text or an id of a person. `line.text` is what to broadcast (starred when the profile stars swearing). `hiddenFor` lists the seats of that room that must **not** be sent the line (their occupant muted or blocked the sender, or the sender blocked them); empty most of the time. An unknown seat is `{ ok: false, refused: { reason: "gate" } }`, as `cw.chat.accept`. |
| `POST /rooms/{room}/seats/{seat}/phrases` | `{ phraseId }` | as `lines` | Phrase-only rooms (4.4). `phraseId` is a token. Unknown id: refused `phrase_unknown`. In a room that is not phrase-only: refused `gate`. |
| `GET /rooms/{room}/seats/{seat}/mutes` | none | `{ muted: [seat], blocked: [seat] }` | Seats whose current occupant this seat muted or blocked. Seat ids only. |
| `PUT /rooms/{room}/seats/{seat}/mutes/{target}` | `{ kind?: "mute"\|"block" }` (default `mute`) | `{ ok: true }` | Muting or blocking oneself, or an empty seat, does nothing and answers ok. |
| `DELETE /rooms/{room}/seats/{seat}/mutes/{target}` | none | `{ ok: true }` | Removes a mute or a block (an unblock removes the row; it does not leave a mute). |
| `POST /rooms/{room}/seats/{seat}/reports` | `{ target, lineId?, reason?, note?, entity? }` | `{ ok: true, remaining, detailUntil? }` or `{ ok: false, refused, remaining? }` | `cw.reports.submit`. `target` is the reported seat. `entity`: `{ kind, ref, label }` (4.5). No report id is returned. Idempotent with the header. |
| `POST /notices/pending` | `{ who }` | `{ notices: PlayerNotice[] }` | `cw.notices.pending`: unacknowledged, oldest first, the same value the player route sends. An unknown person: empty. |
| `POST /notices/{id}/ack` | `{ who }` | `{ ok: boolean }` | `ok: false` (still 200) for a notice that is not the caller's, so ids cannot be probed. |
| `POST /record` | `{ who }` | `{ record: PlayerNotice[] }` | "My record". |
| `POST /restriction` | `{ who, roomId?, seatId? }` | `{ restricted, until, kind }` | `cw.chat.restricted`. |
| `POST /names/check` | `{ name, kind?: "player"\|"entity", who? }` | `{ ok: true }` or `{ ok: false, reason, rule }` | `cw.names.check` (4.5). |
| `POST /doors/check` | `{ kind: "join"\|"create"\|"public"\|"matchmaking", who }` | `{ ok: true }` or `{ ok: false, refusal: { kind, until, refCode, noticeId? } }` | `cw.doors.check`: the login and matchmaking check. |
| `POST /blocks/between` | `{ who, others: [who] }` (1..50) | `{ blocked: [boolean] }` | Is the first person blocked, in either direction, with each of the others? Persons are found, never created; an unknown person is `false`. For matchmaking. |

Statuses: 200 for every answer above (a refusal is an answer), 400 `invalid_request` / `invalid_json` / `forbidden_key` /
`invalid_idempotency_key`, 401, 404 `not_found` (an unknown route, or a path that cannot match), 405, 409 (`in_progress`,
`idempotency_mismatch`), 413, 429. A route never answers 500 with a stack; an unexpected error is 500 `internal` and a log line by
class (the same `withErrors` as every other route).

What a response never holds: a subject id, a person id, a hash, a seat-to-person mapping, a moderator, a reason a moderator wrote, a
rule's private note, or the matched term. `noticeId` and `refCode` are the player's own handles, as in the chat wire.

### 3.4 The process: `chatwarden serve`

```
chatwarden serve [--port 8787] [--host 127.0.0.1] [--db ./chatwarden.db] [--profile-file profile.json]
                 [--terms-file terms.json] [--hub element|none] [--shared-pacing] [--print-openapi]
```

Every flag has an environment twin (flag beats environment beats default): `CHATWARDEN_PORT`, `CHATWARDEN_HOST`, `CHATWARDEN_DB`,
`CHATWARDEN_PROFILE_FILE`, `CHATWARDEN_TERMS_FILE`, `CHATWARDEN_HUB`, `CHATWARDEN_SHARED_PACING`. The secrets are environment only:

| Variable | Required | Meaning |
| --- | --- | --- |
| `CHATWARDEN_SECRET` | yes | The kit's hashing secret (32+ characters). **No development default** in service mode: a missing one is exit 2. Changing it makes every returning player a new person. |
| `CHATWARDEN_SERVICE_KEYS` | yes | The service keys above. None is exit 2. |
| `CHATWARDEN_ADMIN_TOKEN` | no | The staff sign-in of the starter (same shared-token starter as `init`, fail closed: unset means every staff route is 401 and the hub page is not served). Role `owner`, actor `admin`. |
| `CHATWARDEN_AUTH_MODULE` | no | A path to an ES module whose default export is `{ authorize(req) }` (the adopter's own staff auth, as `adminRoutes` takes it). Beats the token. The only place `serve` runs adopter code. |
| `CHATWARDEN_PROCESSES` | no | How many service processes the operator runs (default 1); above 1 raises the `pacing_per_process` warning unless shared pacing is on. |

What it serves: `/v1/*` (service keys), `/admin/*` (staff, `adminRoutes`), `/mod` and the hub script (when `CHATWARDEN_HUB` is
`element`, the default, and staff auth is configured), `/healthz` and `/readyz` (`healthRoutes`). One `http.createServer` over
`toFetch` through a small Node bridge (`node.ts`: request to `Request` with a byte cap, `Response` to the socket with backpressure on
streams, no `x-forwarded-*` trust). Startup order: validate configuration, open the store (migrations run), build the matcher from
`terms.json` or the synthetic pack, `createChatwarden`, mount, listen; any failure before listening is exit 2 with one sentence that
names the variable and never its value. `SIGTERM` and `SIGINT`: stop accepting, wait up to 10 seconds for open requests, close the kit
and the store, exit 0. Logs are JSON lines on stderr, event and error class only (the kit logger), plus one line per request holding
`rid`, `kid`, method, route pattern (never the path with ids), status and milliseconds.

The profile is `profile.json`: a `ModerationProfile` (or `{ "preset": "strict", ...overrides }`) validated by the core; absent means
the `standard` preset. Contexts (4.1) and phrase books (4.4) are written in it; `names.reserved` too. The synthetic term pack is used
when no `terms.json` is given, with a `synthetic_terms` warning in the handshake and one log line at start.

### 3.5 `chatwarden init --service` and the Docker recipe

`init --service` writes a self-contained folder (default `chatwarden-service/`, `--dir` to change; no `package.json` needed, no Node
project needed). It follows every K4b rule: new files only, conflicts skipped by default, no secret written, no network, idempotent,
`--dry-run`, `--json`. It is a usage error with the framework, chat, hub or Discord flags (they do not apply); `--store` and `--profile`
still do. Files:

| File | What it is |
| --- | --- |
| `Dockerfile` | `FROM node:22-slim`; `ARG CHATWARDEN_VERSION=<the CLI's own version, exact>`; installs `@chatwarden/core @chatwarden/http @chatwarden/store-sqlite @chatwarden/matcher @chatwarden/profanity @chatwarden/hub-element` at that version with `npm install --omit=dev --no-audit --no-fund` into `/app`; runs as the non-root `node` user; `VOLUME /data`; `ENV CHATWARDEN_DB=/data/chatwarden.db CHATWARDEN_HOST=0.0.0.0`; `EXPOSE 8787`; `HEALTHCHECK` that fetches `/readyz`; `CMD ["node", "node_modules/.bin/chatwarden", "serve"]`. No secret in the image; `.dockerignore` keeps the folder's own files out. |
| `compose.yaml` | One service, the volume, the three required variables read from the environment, port 8787 bound to `127.0.0.1` by default (the comment says to put a TLS proxy or a private network in front before exposing it). |
| `.env.example` | `CHATWARDEN_SECRET=`, `CHATWARDEN_SERVICE_KEYS=`, `CHATWARDEN_ADMIN_TOKEN=` with the one-line `openssl rand -base64 32` hint. Placeholders only. |
| `profile.json` | The chosen preset as editable JSON, with `contexts` and `names.reserved` shown as empty objects/arrays. |
| `README.txt` | Twelve lines: build, run, the first `curl`, where the hub is, and "the synthetic term list is a placeholder". |

The Dockerfile is a recipe, not an image: nothing is pushed anywhere. `examples/service/` holds the same files (generated by the same
templates; a test fails when they differ) plus `curl.sh`, a script of the five core calls against `$BASE` and `$KEY`.

### 3.6 Clients

- **`createServiceClient({ baseUrl, key, fetch? })`** in `@chatwarden/http/service`: a typed wrapper (one method per route, the
  refusal types, `Idempotency-Key` generated per call and reused across its own retries, a bounded retry with backoff on network errors
  and 5xx, never on 4xx). It is what the conformance tests use and what a Node game that talks to a remote service uses.
- **C# sample** (`examples/service-csharp/`): `ChatwardenClient.cs` (about 200 lines over `HttpClient` and `System.Text.Json`: `Seat`,
  `Unseat`, `CheckLine`, `Report`, `PendingNotices`, `Ack`, `Restriction`, `DoorsCheck`, `Mute`), a `Program.cs` demo that runs the
  whole conversation of the curl script and exits non-zero on any surprise, and a `.csproj` for .NET 8. It sends `Idempotency-Key`,
  honours `retry-after` on 429 and treats an unknown refusal reason as `unknown`.
- **`curl.sh`**: the five core calls, readable top to bottom.

`SERVICE_OPENAPI` is an OpenAPI 3.1 document built from the same route descriptions as the table (`chatwarden serve --print-openapi`
prints it); a test fails when it and the route table disagree on a method and path, or when `examples/service-csharp` calls a path
that is not in it.

### 3.7 Shared pacing (G18)

**What it is.** An optional pacer whose state is in the store instead of the process. Turned on by one code or serve option,
`sharedPacing: true` (`createChatwarden` option, `--shared-pacing`, `CHATWARDEN_SHARED_PACING=1`): it is a property of how the game is
deployed, not a moderation setting, so it is not in the profile or the hub. It needs a store that has the three methods below;
`createChatwarden` throws a plain message when it is on and the store lacks them. Off, the in-memory pacer is exactly as before.

**State.** One row per (room, person), what the in-memory `KeyState` holds: the time of the last committed line, the times of the last
committed lines (at most the burst's `lines`), the digests (16 hex characters, never text) of the last 8 lines, the last flood-signal
time, and `touchedAt`. `who` is the canonical subject id, or `seat:<seatId>` for a guest, as in the in-memory key.

**Store methods** (synchronous, optional; memory and SQLite):
- `paceLoad(roomId, who): PaceStateRow | null`.
- `paceUpdate(roomId, who, fn): PaceStateRow`: runs the pure function `fn(prev | null) => next` as one atomic step (SQLite: one
  `BEGIN IMMEDIATE` transaction, so two processes committing for one player serialise and both lines are counted).
- `paceDropRoom(roomId): number` and `paceSweep(before): number` (delete rows with `touched_at < before`).

**Behaviour.** The decision logic of `pacing.ts` becomes a pure function `decide(state, pace, now, lineDigest)` and a pure
`commitState(prev, pace, now, lineDigest)`, used by both pacers, so the two cannot drift (the differential test runs one script
through both). `createSharedPacer` does: `check` = `paceLoad` then `decide`; a flood verdict that earns a signal writes
`floodSignalAt` through `paceUpdate` (so one flood is signalled once per burst window across processes); `commit` = `paceUpdate` with
`commitState`; `dropRoom` = `paceDropRoom`; every 256 commits it sweeps rows older than an hour (the longest window any check can have).
Cost: one indexed read per line in a room where a check is on (`active(roomId)` is still false for a room with everything off, so those
rooms touch the store not at all), one upsert per accepted line.

**Honest limits.** A check and its commit are two steps, so two processes judging one player's lines in the same millisecond can both
pass `check`; the commit then merges both, and the next line is judged on both. That is a soft limit with a window of a few
milliseconds, the same strength as the in-memory pacer between `check` and `commit` today. A store failure fails open (the line goes
on, the class is logged at most once a minute), as the in-memory pacer does. `cw.rooms.setPace` overrides stay per process: with several
processes the game calls it in each, or relies on the profile's pace (one setting for the whole store). The fixed `rate` window
(3 lines per 5 seconds per seat) and the automatic-timeout memory stay in process; they are a floor, not the feature.

### 3.8 One process per room set: what is and is not shared

| Per process (unchanged) | Shared through the store (SQLite file) |
| --- | --- |
| Seats and the roster; the evidence buffer; the fixed `rate`; in-memory automatic restrictions; the mute index; the idempotency table; pace overrides from `setPace` | People, sanctions, reports, notices, terms, appeals; the pacer when `sharedPacing` is on |

So a service can run as several processes behind a load balancer only if a **room's calls always reach the same process** (consistent
hashing on the room id, or sticky routing); then pacing also agrees across processes where a player moves between rooms. Service mode
documents "one process" as the default and the warning code when it is not. A shared evidence buffer, Postgres and Redis are K14.

## 4. Part B: many rooms, many players

### 4.1 Contexts: rules per room (G9)

**Declaring.** In the profile, in code (or `profile.json`), never in the stored layer and never in the hub:

```ts
profile.contexts = {
  kids:   { label: 'Kids rooms', profanity: { mode: 'refuse' }, pace: { slowModeMs: 3000 }, chat: { phrases: 'junior' } },
  ranked: { label: 'Ranked', profanity: { mode: 'allow' } },
  whisper: { chat: { minAccountAgeDays: 7 } },
}
```

A context name is `^[a-z][a-z0-9_-]{0,31}$`; at most 20 contexts; unknown keys are refused with their path
(`contexts.kids.pace.slowModeMs`), never echoing a value. A context overrides only the **chat-time sections**:

| Key | Type | Meaning |
| --- | --- | --- |
| `label` | string, 1..40 | The name on the case chip. Default: the name. |
| `profanity` | partial `ProfanityConfig` (`mode`, `style`, `add`, `remove`, `only`, `languages`) | Merged over the base: a key left out inherits, an array replaces. |
| `pace` | `PaceSettings` | `mergePace` over the base: a field left out inherits, `null` turns that check off. |
| `chat.phrases` | string \| null | The id of a phrase book (4.4): the room is phrase-only. |
| `chat.minAccountAgeDays` | 1..365 \| null | A player whose account is younger, or whose age the game cannot tell (no account, the `accountAgeDays` hook answers null), is refused `account_too_new`. |

The conduct levels, ladder, durations, reporting reasons, appeals, signals and names are the game's one policy. The set of chat-time
sections is one list in the code (`CONTEXT_SECTIONS`); the chat-filter theme adds `filters` to it (section 13).

**Selecting.** A room is in a context by its tag: `cw.rooms.seat(room, seat, who, handle, { context: 'kids' })`, or `tags.context`
in the service's seat route. The tag is read from the roster on every line (a cheap lookup; the merged result is cached by name and
dropped when the profile object changes). Seating with a malformed `context` value is a `RangeError` (a bug in the game's code: the
call is made where the game sets a room up). A well-formed name the profile does not declare is **not** an error at seat time: every
line in that room is refused `gate` (fail closed, the way a throwing gate hook is) and one `chatwarden.context_unknown` line is logged
per room, so a typo in a kids room fails shut instead of falling back to the relaxed base. A room with no `context` tag uses the
base.

**Precedence for a room's rules**, lowest to highest: the profile in code, the stored layer (the hub), the context, `cw.rooms.setPace`
(this room, this process). So an owner changing the base pace in the hub still reaches a context that does not override pace, and a
context beats the hub for what it sets. `cw.contexts` reads it: `names()`, `of(roomId): string | null`, and `effective(name | null):
{ profanity, pace, chat }`, a pure function the preview and the guide use (section 13).

**What a context never does.** It never changes who may be sanctioned or how; never sets the term list (one list, one matcher); never
hides a room from staff. A report from a context room keeps its tags (it already does), so the case can say which context it came from.

### 4.2 Staff scope (G9)

**Declaring.** A room carries one more reserved tag, `scope`: `^[a-z0-9][a-z0-9:_.-]{0,63}$`, for example `creator:alice`. It is a label
the game chooses; it is independent of `context` (a room can have either, both or neither). The staff hook may return a scope:
`authorize(req) => { actor, role, scope?: string[] }`, 1..20 labels in the same grammar. A caller with no `scope` is **global** and sees
everything, as today. A caller with a scope is **scoped**; the `owner` role cannot be scoped (a malformed `Authz`, 401, fail closed).

**Stamping.** A report stores the room's `scope` tag in a new indexed column when it is filed (`kit_reports.scope`; null when the room
has none).

**Enforcement is default-deny.** Every admin route declares whether it is scope-aware. A scoped caller gets 403 `forbidden` from every
route that does not, and `GET /me` lists in `can[]` only what a scoped caller may do, so the hub hides what it cannot reach. The
scope-aware routes and what changes:

| Route | For a scoped caller |
| --- | --- |
| `GET /reports`, `POST /cases/next`, `GET /changes` counts | Only reports whose `scope` is in the caller's list (a store query filter, `ReportListQuery.scope` and `OpenReportQuery.scope`). A report with no scope is invisible to a scoped caller. |
| `GET /reports/{id}`, `POST /reports/{id}/decide`, `suggest`, `/cases/{ref}/claim\|release\|viewing` | 404 `not_found` (not 403: the case's existence is not confirmed) when the report is out of scope. |
| `GET /people/{ref}/history` | Reports in scope and the sanctions that came from them (`reportId` in scope) only; no account ids, no signals, no other-room transcripts, no linked-accounts data. A person with nothing in scope is 404. |
| `GET /sanctions`, `POST /sanctions`, `/sanctions/{group}/revoke` | Reads as above. Apply is limited by `scopedLimits` (default: kinds `warning` and `chat`, at most 7 days, a `reportId` in scope required); revoke only a sanction that came from an in-scope report. |
| `GET /me`, `GET /reasons` | Allowed. `/me` also returns `scope`. |

Not scope-aware, so denied to a scoped caller: policy and settings, terms, community list, blocked, names and rename, handles, audit,
appeals, AI, gaps, team and saved reasons writes, bulk dismissal, and every route a later theme adds until it declares itself
scope-aware. Scope is filtered in the **store reads**; a route that forgot to pass it would return empty or 404 rather than leak, and
a contract test per query proves the filter. A decision a scoped moderator makes is audited with the same actor; the audit row's
detail is unchanged.

### 4.3 Block (G10)

**What it is.** A mute the viewer makes lasting and two-way. Block and mute share one row per pair in `kit_mutes` (a new column
`block`, 0 or 1); the latest action wins; muting a pair that is blocked changes nothing; unblocking removes the row.

| | Mute (today) | Block (new) |
| --- | --- | --- |
| Viewer sees target's lines | no | no |
| Target sees viewer's lines | yes | **no** |
| Lasts | 180 days from last action | until undone (never purged by age) |
| Counts toward the 500-per-viewer cap | yes | yes; when the cap is reached the oldest **mute** is dropped, never a block |
| The target is told | no | no (nothing changes visibly for them except that they stop being answered; the kit tells no one) |

**Behaviour.** `cw.chat.visibleTo(room, viewerSeat, senderSeat)` is false when the viewer muted or blocked the sender **or** the sender
blocked the viewer. `cw.mutes.mutedSeats` is unchanged; `cw.mutes.blockedSeats(room, viewerSeat)` is new. A new `cw.blocks`:
`set(room, viewerSeat, targetSeat, on)`, `between(whoA, whoB): boolean` and `anyBetween(who, others): boolean[]` (persons found by
`RawWho`, never created; two guests are never blocked; a merged person's blocks follow the merge, as mutes do). There is **no call that
lists a person's blocks**: the kit holds only hashes, so it could not return the game's ids, and a list of "who blocked whom" is the
sort of thing the audit says never reaches a player. The game asks about the pairs it is about to put together.

**Chat box and wire.** The chat routes' mute body gains `block?: boolean`; `WireMuted` gains `block?: true`; when a block is made, the
broadcaster sends the blocker's `hide` frame as today **and** a `hide` frame of the blocker's lines to the blocked player's streams (so
history already on screen disappears for them too), and later lines in either direction are filtered by `visibleTo`. The chat box's
line options (the existing `...` per line, which holds Report and Mute) gain **Block {name}**, behind a one-line confirm
("They will not see your messages either. You can undo this in Chat options."); Chat options' "Muted players" list becomes "Muted and
blocked players" with the same Undo. No new control is always visible.

**What a game is told.** `hiddenFor` in the service line answer; `cw.blocks.between` at matchmaking; nothing about who blocked whom
reaches staff screens in this release (non-goal).

### 4.4 Phrase-only chat (G11)

**Books.** The game declares phrase books in code: `createChatwarden({ phrases: { junior: [{ id: 'gg', text: 'Good game!' },
{ id: 'help', text: 'Can you help me?', group: 'Ask' }, ...] } })`. A book id is `^[a-z][a-z0-9_-]{0,31}$`; at most 20 books of
at most 300 phrases; a phrase `id` is `^[A-Za-z0-9_-]{1,32}$` and unique in its book; `text` is 1..100 characters with no control or
bidi characters; `group` (optional, 1..24 characters) heads a section in the picker. `text` is the game's default language: it is what
evidence, moderators and a client without a translation see. At start-up `createChatwarden` runs **each phrase through the matcher
and the profanity filter** and throws `PhraseBookError` naming the book and phrase id (never the text) when one hits: the game's own
phrase list cannot contain a slur.

**Using.** A context with `chat.phrases: 'junior'` makes every room tagged with it phrase-only. `cw.chat.acceptPhrase(room, seat,
phraseId): ChatResult` runs the **same pipeline as `accept` without the text steps**: occupant and gate, restriction, minimum account
age, pacing, the fixed rate, then deliver; there is no matcher, no profanity, no length check (the text is trusted). The line is
buffered as evidence with `raw` = the phrase's canonical text. `deliver` gains `phrase: id`. In a phrase-only room `accept(text)` is
refused `phrases_only` (no strike, no buffer, no rate spent); `acceptPhrase` in any other room is refused `gate`; an unknown id is
`phrase_unknown`. Both are new `RefuseReason`s with words in the chat catalogue.

**Showing in each viewer's language.** The wire line gains `phrase?: string` beside `text`. The `hello` frame gains `phrases:
{ book: [{ id, text, group? }] } | null` (null for free-text rooms). The chat box renders `t('phrase.' + id)` from **the viewer's own
catalogue** when it has the key and falls back to `text`; the game puts its translations in the catalogue it already passes (the
kit ships no phrases and no phrase translations). The sender picks from the same list in the sender's language. A client that
ignores `phrase` shows `text`, which is correct, in the game's default language.

**Chat box.** When `hello.phrases` is not null the free-text input is replaced by a `PhrasePicker`: a labelled list of buttons
(grouped under headings, a filter box when there are more than 12), each sending `POST /rooms/{room}/phrases`. Keyboard: the list is
one tab stop with arrow keys; Enter sends; the live region announces the result as for a line. Reporting and muting a phrase line work
as for any line.

**Service.** `POST /v1/rooms/{room}/seats/{seat}/phrases`. The game's own client shows the phrases (the service's `GET /v1`
capabilities carry the book names; the book content is the game's, already in its own build).

### 4.5 Reserved names and names for entities (G12)

This builds on the names machinery of 0.1.9 (`cw.names.check`, `NameService`, `matchName`, `rename.required`), which the
names-in-reports theme also extends (section 13).

**`names.reserved`** (a list in the names settings, an editable section like the rest of `names`): 1..200 entries, each 2..32
characters, for example `admin`, `moderator`, `game master`, or the first name a staff member plays under. And **`names.reservedAllow`**
(1..200 exact names, for a real player who happens to be named like staff). Empty by default: nothing is reserved until an owner says so.

**Matching.** `skeleton(text)` (new, in `@chatwarden/matcher`, exported): NFKD with marks and format characters removed
(`stripInvisible`), then the engine's own chain (`transformLikePreset`: confusables, leetspeak, case, repeated letters collapsed), then
everything that is not `[a-z0-9]` removed. A name matches an entry when any contiguous run of the **words of any of its views**
(`nameViews`: the name, split on underscores and camel-case humps, with digit runs removed) has the entry's skeleton, or the whole name's
skeleton equals it. So `Mod_Anna`, `M0d_Anna`, `ModAnna`, `m o d anna` (a space is a word break) and `Moderator` match the entry
`moderator` or `mod`; `xXadminXx` and `Sodmin` do not (a name is a whole-word match, like chat). A name whose whole skeleton equals a
`reservedAllow` skeleton is allowed. Reserved names are compared only on names, never on chat.

**The answer.** `cw.names.check(name, { who?, kind?, skipReserved? })` gains a third reason, `name_reserved`. A reserved name is not a slur,
so it does not cite the slur rule: it cites `names.reservedRule` (an active Community Rule number; default 2, the rule impersonation and
personal info already map to). `kind: 'entity'` is a name for a clan, guild, team, deck, pet or item:
the same checks, and a blocked entity name is kept as evidence only when the caller gave `who` and `names.keepBlocked` is on, like a
player name. `skipReserved: true` is for the game's own staff signup. The player route and the service route take `kind` in the body.
The player words gain `player.name.reserved`.

**A report about an entity.** `ReportInput.entity?: { kind: string, ref: string, label: string }` (`kind` `^[a-z][a-z_]{0,23}$`, `ref`
the game's opaque id of the entity, token, 1..64, `label` 1..64 characters, no control characters). The report is filed against the
**owner's seat** (`target`) as always, so the person is the case; the entity is stored on the report (`kit_reports.entity_json`) and the
case shows one extra row, "Clan: {label}" (the kind word is a word of the game's, so the row says "Entity" for an unknown kind), the
label shown through the same masking the names theme gives names in reports (a flagged label is hidden until shown). A new default
report reason `impersonation` ("Pretending to be staff or someone else", group Chat, CR 2) is added **disabled** (`enabled: false`),
so it appears in Settings > Reporting for an owner to switch on and in no player's report dialog until they do.

**Renaming an entity.** The Person page's existing rename form gains an optional entity (`POST /people/{ref}/rename` takes `entity?: {
kind, ref }`, filled in when the case has one). For an entity the kit creates **no notice** (the kit has no screen for a clan, and a
generic "change your name" notice would be wrong); it emits `rename.required` with `entity: { kind, ref }` and writes the audit row
`name.rename_required`, and the game tells the owner in its own UI and calls `renamed` for the player as today. A rename of an entity
does not set the person's "pending rename".

### 4.6 UI summary (clean core, one advanced door)

| Where | What | Visible when |
| --- | --- | --- |
| Case (Cases queue) | A chip with the context's label | the profile declares at least one context and the report's room had one |
| Case | One row "Clan: {label}" | the report carries an entity |
| Settings > Advanced | A read-only "Room contexts" list (name, label, which sections it overrides) | always inside Advanced; empty state says contexts are set in code |
| Settings > Advanced > Names panel | Two textareas, "Protected names" and "Allowed exceptions" | always inside the existing panel |
| Settings > Reporting | The `impersonation` reason, switched off | as the other reasons |
| Terms (Add term) | A "Match" choice | only after the typed term is in an unspaced script |
| Chat box line options | "Block {name}" | always (inside the existing `...` menu) |
| Chat box | The phrase picker instead of the input | the room is phrase-only |
| Everything else in this note | none (service mode has no hub UI of its own) | |

No new tab, no new always-visible badge, no new colour. Every string goes through `t()`.

## 5. Part C: more languages

### 5.1 Catalogues for Spanish and Portuguese (G16)

**What ships.** `@chatwarden/player-react/locales/es` and `/pt` (player words, the chat box's words and the report-dialog defaults of
5.1.3) and `@chatwarden/hub-react/locales/es` and `/pt` (the hub's 1434 keys and the AI parts' 202), as lazily loaded modules, each
exporting `es` (or `pt`), and `meta`. Subpath exports, not part of any entry's first load; the size budgets do not move.

**Honesty, in the data and in the words.** Both catalogues are **machine-drafted** (by an AI model, in this release) and **not reviewed by
any native speaker**. Every file begins with a header saying so; `meta` is `{ locale, status: 'machine-draft', reviewedBy: [],
reviewedAt: null }`; the README and the package's translation guide say it in the first line of the languages section; and a test fails if
`status` is anything but `machine-draft` while `reviewedBy` is empty, or if the words "reviewed", "verified", "native" or "official" appear
in a catalogue file outside the header. Moderation words (a refusal, a ban notice, an appeal outcome) are the most sensitive copy in the
kit: the guide tells an adopter to have a native speaker read **at least** the notice, refusal and appeal keys (it lists them) before
turning the language on for players, and offers the English fallback as the safe choice. Changing `status` is a pull request with a
reviewer's name, never part of a drafting task.

**Choices made for the drafter** (so a reviewer knows what to challenge): Spanish is neutral Latin American written in the informal
second person (`tú`, never `vos` or `usted`), because the player copy is written for a player in the middle of a game; Portuguese is
Brazilian (`você`), with `pt-PT` mapped to it and a note that a European game wants its own pass. Gendered nouns are avoided where the
sentence allows ("persona", "pessoa", "jogador ou jogadora" only when unavoidable). Placeholders (`{name}`), plural suffixes and
punctuation structure are preserved; community terms ("Community Rule", "strike", "ban") follow the words most Spanish and Portuguese
games use.

**Completeness is a test.** For each locale: every key of `en` (and `enChat`, and the AI words) is present and no key outside them; the
`{placeholder}` set of every string equals the English one; every plural base has `.one` and `.other` (the categories es and pt need
here; `many` falls back to `.other` as `createT` does); no string is empty; no string is identical to its English source unless it is on
a short allowlist (brand names, "OK", symbols); no catalogue text contains markup. A translator adds keys to the allowlist by
pull request.

**Loading on demand.**
- `matchLocale(requested, available = ['es', 'pt']): 'es' | 'pt' | null` in both packages: BCP 47 base subtag, case-insensitive,
  `es-MX` and `es-419` are `es`, `pt-BR` and `pt-PT` are `pt`, anything else null.
- `loadPlayerT(locale): Promise<PlayerT>` merges `{ ...en, ...enChat, ...catalogue }` and returns `createT(merged, locale)`; the
  game passes it as `t` (the player components stay catalogue-agnostic). An unavailable locale returns the English `t`.
- The hub: `HubProvider` and `<chatwarden-hub locale="...">` with no `t` given and a locale `matchLocale` knows load the catalogue
  with a dynamic import and the AI words with it, and show the hub's existing loading state until it arrives (no flash of English); a
  failed load keeps English and logs nothing outward. An adopter's own `t` always wins.
- Dates, numbers, plurals and `Intl.DisplayNames` already follow `locale`.

**Report reasons, the thank-you and server English (5.1.3).** The default report reasons' labels and hints and the default thank-you
text are English strings that travel in the profile (`GET /rules`), so a Spanish dialog would show English reasons. The report dialog
now looks up `player.report.reason.<id>.label`, `.hint` and `player.report.thanks` in the catalogue and **uses the catalogue text only
when the server's text equals the English default for that key** (the owner has not customised it); a customised label is the game's
own words and is shown as sent. The English defaults are `en` keys and a test keeps them equal to core's `DEFAULT_REPORT_REASONS`.
Rule titles and text, the profile summary and the code of conduct stay the game's: documented with the exact `GET /rules` fields an
adopter translates.

### 5.2 Matching for scripts written without spaces (G17)

**Scope.** Han (Chinese, and kanji), Hiragana, Katakana, Thai, Lao, Khmer, Myanmar: the **unspaced scripts**, a set of Unicode scripts
in one list in the code. A term whose letters are all in that set (a Japanese term may mix Han, Hiragana and Katakana) is an
**unspaced term**; a term of plain `a-z` letters is a Latin term, as today; any other term is still a `MatcherBuildError` ("this
script is not supported yet", naming the row id).

**Term rows.** A row keeps `{ id, term, language, active }` and gains an optional `matchMode`: `'word'` (a Latin term; the only
mode for one), `'segment'` (the default for an unspaced term) or `'contains'`. A `word` term in an unspaced script, or `segment` or
`contains` on a Latin term, is refused. Unspaced terms are at least 2 code points (3 for `contains`), at most 24, with no space,
punctuation or digit. `language` picks the segmenter locale (`zh`, `ja`, `th`, `lo`, `km`, `my`).

**Normalising (the unspaced path).** NFKC, not NFKD: decomposing would turn Japanese `が` into `か` plus a mark and then drop the mark,
and Thai vowel signs and tone marks are marks that carry the word. So only format characters (`\p{Cf}`), the blank fillers the matcher
already lists and variation selectors are removed, and Hiragana and Katakana are folded to one (a term in either spelling matches
both). Both the term and the text are read this way. The text is cut into grapheme clusters first, each normalised on its own, and every
output character remembers its cluster's range in the original, so `spans()` still gives exact ranges on the typed text.

**Matching.** The text is split into **runs** of unspaced-script characters (anything else, including spaces, punctuation, digits and
Latin letters, ends a run). For each language that has an active `segment` term, the run is segmented with `Intl.Segmenter(language,
{ granularity: 'word' })` and its boundary offsets are collected. A `segment` term hits an occurrence in the run whose start **and**
end are both segment boundaries (the term occupies whole segments, so `ABC` inside the dictionary word `XABCY` does not hit, and an
unknown slang term that the segmenter splits into single characters still does). A `contains` term hits any occurrence. An exception
(an unspaced phrase) covers a hit that lies inside an occurrence of it whose own edges are boundaries by the same rule. A line is
matched by the Latin engine and by this path; either may block it; both feed `match`, `spans` and `matchName`. A text with no
unspaced-script character, or a matcher with no unspaced term, takes no extra work.

**Honest limits.** Segmentation is a dictionary algorithm and changes between ICU versions, so precision and recall can move when Node
does: the corpus gate (every term ships with lines it must and must not match) runs on both Node versions in CI, the dry-run in the
hub shows the effect of a term before it is saved, and `contains` exists for a severe term an owner would rather match everywhere
than risk missing. A runtime with no `Intl.Segmenter` and an active `segment` term fails `buildMatcher` with a `MatcherBuildError` that
says so (a missing capability is not silently weaker). Characters inserted between letters, homophones, pinyin and simplified/traditional
conversion are not read (a term is added in each form that matters), exactly as spaced-out Latin letters are not today: a report
catches them.

**Where it surfaces.** `LiveTerms` takes `matchMode` on add and edit and the dry run reports it; `kit_terms` stores it (`match_mode`);
`POST /terms`, `PATCH /terms/{id}` and the row bodies carry it; the hub's Add term form shows "Match: whole words (recommended) /
anywhere in the text" only after the typed word is in an unspaced script; the corpus loader accepts an optional `matchMode` per row and
the selection languages `zh`, `ja`, `th`, `lo`, `km`, `my` (the corpus's own contents are the corpus's, and no real list is added to
this repository).

## 6. Settings summary

Everything is off or empty by default.

| Setting | Where | Default |
| --- | --- | --- |
| `sharedPacing` | `createChatwarden` option, `serve --shared-pacing` | false |
| `profile.contexts` | profile in code or `profile.json` (not the hub) | none |
| `names.reserved`, `names.reservedAllow`, `names.reservedRule` | names section (hub Settings > Advanced > Names) | `[]`, `[]`, 2 |
| `phrases` (books) | `createChatwarden` option | none |
| `Authz.scope`, `scopedLimits` | `authorize` result, `adminRoutes` option | global; warning and chat, 7 days |
| service: keys, rate limit, `CHATWARDEN_*` | `serviceRoutes` options, environment | no keys, no start |
| `matchMode` | per term | `segment` for unspaced terms |
| report reason `impersonation` | Settings > Reporting | present, disabled |

## 7. Migration 26 (this note's part)

The whole release shares one migration, version 26. These are the additions of this note, each a labelled block in the one `sql` string
(other themes add their own blocks; nobody adds a 27):

1. `CREATE TABLE kit_pace (room_id TEXT NOT NULL, who TEXT NOT NULL, last_at INTEGER NOT NULL, stamps_json TEXT NOT NULL, recent_json TEXT NOT NULL, flood_signal_at INTEGER, touched_at INTEGER NOT NULL, PRIMARY KEY (room_id, who)) WITHOUT ROWID` and `CREATE INDEX kit_pace_by_touched ON kit_pace (touched_at)`.
2. `ALTER TABLE kit_mutes ADD COLUMN block INTEGER NOT NULL DEFAULT 0 CHECK (block IN (0, 1))`.
3. `ALTER TABLE kit_reports ADD COLUMN scope TEXT`, `CREATE INDEX kit_reports_by_scope ON kit_reports (scope, status, created_at)`, and a one-statement backfill `UPDATE kit_reports SET scope = json_extract(tags_json, '$.scope') WHERE json_extract(tags_json, '$.scope') IS NOT NULL`.
4. `ALTER TABLE kit_reports ADD COLUMN entity_json TEXT`.
5. `ALTER TABLE kit_terms ADD COLUMN match_mode TEXT CHECK (match_mode IS NULL OR match_mode IN ('word', 'segment', 'contains'))` (null means "by script").

Retention: `kit_pace` is operational state swept at an hour (no setting); `purgeMutes(before)` skips rows with `block = 1`;
`entity_json` goes with its report. Privacy theme: `kit_pace.who` and `kit_mutes` (both directions of a block) hold subject ids and must be
in the "every table that holds a subject id" list (section 13).

## 8. Wire and API changes in one place

- **Service API v1** (3.2, 3.3): new.
- **Chat wire** (`CHAT_WIRE_VERSION` 1 to 2): `WireLine.phrase?`, `hello.phrases`, `WireMuted.block?`, mute body `block?`, `MuteResult.limit?`, `POST
  /rooms/{room}/phrases`, refusal reasons `phrases_only`, `phrase_unknown`, `account_too_new`. Both copies (`http/chat/wire.ts` and
  `player-react/chat/wire.ts`) change together; the type-equality test keeps them in step.
- **Player routes:** `POST /names/check` takes `kind`; answers `name_reserved`.
- **Admin routes:** `GET /me` gains `scope`; `GET /reports/{id}` gains `context` and `entity`; `GET /policy/contexts` (new, read-only);
  `POST /people/{ref}/rename` takes `entity`; `POST /terms` and `PATCH /terms/{id}` take `matchMode`; every list route takes scope from
  the caller, never from a query.
- **Core:** `cw.rooms.seat` validates the reserved tags; `cw.contexts`, `cw.blocks`, `cw.chat.acceptPhrase`; `ChatResult.deliver.phrase`;
  `ReportInput.entity`; `NameReason` gains `name_reserved`; `RefuseReason` gains three; `Authz.scope`; `Store` gains `paceLoad`,
  `paceUpdate`, `paceDropRoom`, `paceSweep`, `MuteRow.block`, `ReportRecord.scope` and `entity`, `ReportListQuery.scope`,
  `OpenReportQuery.scope`.
- **Events:** `rename.required` gains `entity?: { kind, ref }`; no other event changes (no event carries a name, a phrase or a block).

## 9. Edge cases

- **Service.** A line for a seat in a room the service has never seen: `gate` refusal. `PUT` seat with a room already holding that seat
  for another person: the seat changes hands (the core's rule), earlier evidence keeps naming the earlier occupant. A game restart: the
  roster is empty, every line is `gate` until the game seats again; the game re-seats on reconnect (documented as the contract: seats are
  the game's to keep, the service forgets on restart). `who` with only `ip`: seating is refused 400 (an address alone cannot chat). Two
  service keys in one request: not a thing; the header is one value. An `Idempotency-Key` reused after 10 minutes is a new request.
  A very slow client: the byte cap and a 10-second read timeout in the Node bridge; a hung connection is closed.
- **Shared pacing.** A clock that steps back in one process: a row stamped in the future is stale and never refuses (the existing rule,
  in `decide`). Two processes with different `setPace` overrides: each judges by its own; documented. A store that is read-only or
  locked past `busy_timeout`: fails open and logs. The `seat:<seatId>` guest key collides between processes that reuse seat ids for
  different guests: a guest's pacing is best effort (documented; accounts and client keys do not collide).
- **Contexts.** A room's `context` tag cannot change after the first seat in this release: a second `seat` with a different `context` for
  the same room is a `RangeError` (a room does not switch rules mid-conversation; close and reopen it). Empty `contexts` and no
  tag: the base. A context whose pace turns every check off in a room where the base has them on: `active(roomId)` is false and the
  pacer holds nothing for it.
- **Scope.** A person reported in two scopes is two cases for two moderators; neither sees the other's. A report filed before a room had
  a `scope` tag stays unscoped. A scoped moderator decides a case whose room later closes: nothing changes (the report row has the
  scope). A scoped moderator holds a claim, is then re-scoped (the game's hook returns new labels): the claim is on a report they can
  no longer read; the next request for it is 404 and the claim lapses in 10 minutes.
- **Block.** A blocks B while B is typing: B's already-delivered lines to A's stream are hidden by `hide` frames; B's later lines are
  filtered. A and B in a two-seat whisper room: both sides see silence (the game decides what to do; `between` tells it at
  matchmaking). A blocks someone who then changes account and joins: a new person is not blocked (blocks follow the merged person, not a
  look-alike). 500 blocks and mutes: the cap drops the oldest mute; if only blocks remain, a new mute or block is refused: the mute route
  answers `{ ok: false, hiddenIds: [], limit: true }` and the box says "You have muted or blocked as many players as is allowed".
- **Phrases.** A phrase deleted from the book after a line used it: history keeps the line's `text`; a client with no key for the id shows
  `text`. A phrase whose translated text is wrong is the game's catalogue problem and appears only for that viewer.
- **Reserved names.** A one-letter entry is refused at validation (min 2). An entry that is a common word (`staff` is one; `the` is not
  useful) is the owner's call and the dry run shows which existing blocked-name tests it changes. Unicode look-alikes (Cyrillic `а`) are
  in the confusables table and match; characters outside it do not.
- **Unspaced matching.** A line mixing Chinese and Latin: both paths run. Emoji and punctuation between characters end a run. A run
  longer than 2000 characters is cut at the line limit already. A `ja` term matched against Chinese-only text: the Japanese segmenter
  decides; the corpus gate states which languages a term was tested in.
- **Languages.** `locale="pt-PT"` gets the Brazilian catalogue; `locale="es"` with a game `t` that only has some keys: the game's keys
  win, the rest fall back to English (never the catalogue, unless the game spreads it): an adopter's own `t` is theirs.

## 10. Security and privacy

- **The service is a trusted-caller API.** Anyone holding a key can seat people, send lines and read any person's notices by naming a
  `who`. Treat a service key as a database password: environment only, never in a client build, rotated by the two-key procedure,
  the service on a private network or behind TLS. The service says so in the handshake (`plain_http` warning when a proxy reports
  `x-forwarded-proto: http`), in the README and in the compose file's comment. It adds no TLS of its own.
- **Fail closed.** No keys, no secret, an admin token equal to a service key, or an unreadable profile: the process does not start. A
  malformed `Authz` or scope is 401. An unknown context is `gate`. An out-of-scope id is 404.
- **No identifier out.** No `/v1` answer holds a subject, person, hash, seat-to-person link, moderator or private reason; refusals
  are copied by name. A block is answered only as a boolean for a pair the caller names. No log line holds a key, a `who`, a line, a
  name or a phrase.
- **Raw identifiers.** `who.clientKey`, `accountId` and `ip` are hashed by the core with the secret on arrival and not kept; the
  service keeps nothing raw beyond the request, including in the idempotency table (it holds a fingerprint and the response, which
  holds no `who`).
- **Request hygiene.** Byte-capped bodies, the kit's prototype-pollution check, strict key sets, bounded arrays (`others` at 50),
  bounded tables (idempotency 20 000, limiter keys 10 000, pace rows swept), no regular expression built from input, no outbound request.
- **Scope is a data boundary.** Filters live in the store queries; default-deny covers routes added later; 404 hides existence; a scoped
  caller's `can[]` is trimmed so the UI cannot offer what the server refuses.
- **Blocks.** A block row is the blocker's safety choice: never in a staff screen, an export or an event in this release; the privacy
  theme's export and erase handle it (13).
- **Machine translation.** A wrong refusal sentence is a moderation harm (telling a player something false about a sanction). The
  catalogues are labelled, tested for placeholders and plurals, never claimed as reviewed, and off unless the game chooses the locale.
- **Unspaced matching** adds no network and no new data; the terms themselves remain the owner's.

## 11. Tests that pin it

Each plan task names its own; these are the properties across them.
- **Differential:** the same scripted conversation through `cw.chat.accept` (Node) and through `/v1` over `toFetch` gives the same
  verdicts, refusals and evidence; the same script through the in-memory and the shared pacer gives the same verdict at every step; the
  same lines through a context and through an equivalent whole profile give the same result.
- **Idempotency:** a retried line, with the key, is struck once and answered identically; without it, twice.
- **Scope:** for every admin route, a scoped caller either gets only in-scope data or 403/404; a table-driven test enumerates the
  route table and fails for a route that is neither declared scope-aware nor denied.
- **Block:** symmetric visibility in history, live lines and `hiddenFor`; survives a merge; never purged by age.
- **Phrases:** a phrase book with a hit is refused at start; `accept` text in a phrase room spends nothing.
- **Locale:** completeness, placeholders, plurals, allowlist, no "reviewed" claim; the hub's first-load budget unchanged.
- **Matching:** real-shaped lines in Chinese, Japanese and Thai (synthetic terms only), must-hit and must-not-hit per term, on both CI
  Node versions; Japanese voiced marks and Thai vowel signs survive normalisation; `spans` map back exactly.
- **Off means unchanged:** with none of the new settings given, every existing answer is what 0.1.14 gives (a snapshot per route is
  the check) apart from the changes in section 12.

## 12. Breaking changes (0.2.0 has no adopters; each is deliberate)

None of these needs an upgrade shim.
1. `Store` (an interface adopters implementing a store would meet) gains `paceLoad`, `paceUpdate`, `paceDropRoom`, `paceSweep` (optional),
   and the mute rows and report rows gain fields (`block`, `scope`, `entity`). A custom store written against 0.1.14 must add them.
2. `RefuseReason`, `NameReason`, `ReportRefusal`, the chat wire's refusal reasons and `ChatResult.deliver` gain members: an exhaustive
   `switch` over them stops compiling until it handles `phrases_only`, `phrase_unknown`, `account_too_new`, `name_reserved`,
   `entity_invalid` (and ignores `phrase`).
3. `CHAT_WIRE_VERSION` goes 1 to 2; the chat box and the broadcaster ship together and a mixed pair is not supported (there are no
   adopters running the two apart).
4. `Authz` gains `scope?`; an `authorize` hook returning an object with a `scope` it did not mean is now scoped. The `owner` role with a
   scope is refused.
5. `cw.rooms.seat` reserves the tag keys `context` and `scope` and validates their values; a game that used those keys for another
   meaning must rename them.
6. `ReportListQuery` and `OpenReportQuery` gain `scope`; a store must apply it (a contract test fails one that ignores it).
7. `DEFAULT_REPORT_REASONS` gains `impersonation` (disabled). A snapshot or a count of the default reasons changes.
8. `createChatwarden` throws for `sharedPacing` on a store without the methods, and for a phrase book that hits the matcher.
9. The report dialog shows catalogue text for a default reason label when a catalogue has it and the server's text is the English
   default (a behaviour change for a game that spreads a catalogue and left the reasons at their defaults).
10. The names this note adds ship without `@experimental`, and so do the 0.1.x names it changes (pace, mutes, the chat wire, names,
    the fetch adapter's service use). The release's own sweep of the remaining tags is not a task here. The service API v1 is the first thing
    the project promises not to break.
No existing API is removed.

## 13. Interfaces with the other themes

**I need from names-in-reports and the preview theme**
- *Names in reports:* the helper that masks a name in a report (the hub's `displayName`/"Show" path and whatever server field marks a
  name as flagged). The entity label (4.5) rides it, so a flagged clan name is hidden the way a flagged player name is. I add
  `name_reserved` and the `kind` option to `cw.names.check` and `POST /names/check`; they must not rename `NameReason` or the
  `NameService.check` signature underneath me, and the report-name snapshot columns they add are theirs (mine is only `entity_json`).
- *Preview:* "what the player sees" must take an optional `context` and resolve it with `cw.contexts.effective(name)`; it must show the
  phrase-only state and the language it is previewing (the locale loads through `loadPlayerT`). The guide's "which context" line reads
  `GET /policy/contexts`.

**I give to filters and privacy**
- *Filters:* `profile.contexts.<name>.filters` is theirs to define: they add `'filters'` to `CONTEXT_SECTIONS` and export `mergeFilters`,
  and the context merge calls it with the same base-then-override rule. Their refusal reasons reach the service line answer through
  `refusalOf` with no change here. Their link rule's account-age uses the same `accountAgeDays` hook as `chat.minAccountAgeDays`.
- *Privacy (export and erase):* the tables to enumerate beyond the existing ones: `kit_pace` (`who`), `kit_mutes` (both `viewer_id` and
  `target_id`; erasing a person removes their blocks in both directions), `kit_reports.entity_json` (a label may be a name; it goes
  with the reports the person filed or with the report if they are the owner), `kit_reports.scope` (not personal). Export must not
  include what other people blocked about the person.
- *Retention:* nothing new is configurable from here.

**I need from urgent, desk and rooms**
- Every route they add must declare itself scope-aware or be denied to scoped callers (4.2); the urgent sort and `take next` must
  apply scope in the store query; room modes (`setMode`) are per process like `setPace` and must not use the tag keys `context` or
  `scope`; the Rooms panel lists a room's context and scope when it has them.
- `cw.rooms.setMode` with shared pacing: a mode that changes pace for a room is an in-process override like `setPace` and is not shared.

**Migration.** All of us add blocks to version 26; mine are in section 7.

## 14. Risks

- **Service surface.** A bearer-key API is a larger attack surface than the hub. Mitigated by fail-closed startup, one scope, the
  rate limits, the throttle on failures, and the documented placement (private network). The risk that remains is a leaked key: the
  rotation procedure and the `kid` in logs make it detectable and fixable.
- **The seat contract.** Service mode makes the game keep seats; a game that forgets to re-seat after a service restart sees `gate`
  refusals. The sample clients re-seat on a `gate` for a known seat once, then surface the error.
- **Idempotency in memory** is not a guarantee across restarts or processes; the doc says exactly that.
- **Context and scope matrix.** Profile by context by scope multiplies cases. The differential test and the table-driven scope test
  carry it; the profile sections a context may touch are few on purpose.
- **Segmentation drift** across ICU versions (5.2). CI on two Node versions and the dry run; `contains` as the escape.
- **Machine translation quality.** Mitigated by the labels, tests and the instruction to review the notice, refusal and appeal keys;
  not eliminated.
- **Size.** The hub catalogues are about 90 KB of text each, loaded only when the locale needs them.
- **The C# sample cannot be run in every contributor's environment;** CI builds and runs it against a live service, and a local drift
  test checks the routes.

## 15. Not in this release

German, French, Japanese and other languages (community packs, with the translation guide); a shared evidence buffer, Postgres, Redis,
engine SDKs (K14); a published image; a Go and a Python example server; non-Latin spaced scripts and script conversion in the matcher;
block counts and a staff view of blocks (signals); per-context ladders and reasons; editing contexts in the hub; creator features
beyond scope (follower-only chat); translating the generated code of conduct, the starter rules and the profile summary; a service
route for appeals and the chat box transport (players talk to the game, not to the service); webhook `signal` action for non-Node
games (flood design 12 still parked).

## 16. Rulings

Decisions the owner has not made. Each takes the recommendation unless the owner says otherwise; the plan follows them.

1. **The service is `chatwarden serve` plus `@chatwarden/http/service`; the Docker piece is a recipe under `examples/` and written by
   `init --service`, with no published image.** (Publishing an image is outward and permanent; K4b ruling 1 forbids a new package.)
2. **Authentication is one scope of bearer service keys (up to five, for rotation), compared by digest; no request signing, no mTLS, no
   per-route scopes.** The service sits on a private network or behind a TLS proxy; a signature scheme can be added in `v1` as an
   optional header later.
3. **API v1 is additive-only, versioned in the path, with a handshake that lists capabilities and warnings.**
4. **Idempotency is in-memory, ten minutes, three routes, opt-in by header.** Persisting it is not worth a table for a single-process
   service.
5. **Reads that name a person are `POST`s.**
6. **The service has no player routes; the game's own client draws the UI.** The chat box and `NoticeQueue` remain Node-side.
7. **Shared pacing is a deployment flag, not a profile setting, and shares only the pacer.** `setPace`, the fixed `rate`, seats and
   evidence stay per process.
8. **Contexts are declared in code, chosen by a room tag `context`, and change only chat-time sections (profanity, pace, phrases,
   minimum account age).** Not editable in the hub, so there is no layer-by-context matrix. An unknown context fails closed (`gate`).
9. **Staff scope is a second reserved tag `scope`, stamped on the report; enforcement is default-deny with 404 for out-of-scope ids and
   limited sanctions (warning and chat, 7 days, tied to an in-scope report).** `owner` cannot be scoped.
10. **Block is a kind of mute row, two-way, never expiring; the game asks `between` with raw ids and cannot list blocks.**
11. **Phrase books are code-declared trusted text, checked against the matcher at start; viewers' translations come from the game's own
    catalogue.** The kit ships no phrase text.
12. **Reserved names compare skeletons (look-alike and leet folded) over whole words of the name; an allow list handles real players; an
    entity rename emits an event and writes no notice.** The `impersonation` report reason ships disabled.
13. **Only Spanish (neutral Latin American, `tú`) and Portuguese (Brazilian), machine-drafted and marked so; the code of conduct, starter
    rules and summary are not translated; default report reason text is looked up in the catalogue only while unedited.**
14. **Unspaced matching: segmenter-aligned by default, `contains` opt-in, NFKC (not NFKD) so Japanese and Thai survive, no support for
    spaced non-Latin scripts yet, and a missing `Intl.Segmenter` is a build error.**
15. **New APIs ship stable at 0.2.0 (no `@experimental`), and the service API v1 is the first compatibility promise.**
16. **The C# sample is built and run in CI against a live service; locally only a route drift test runs.**
