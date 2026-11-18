# @chatwarden/http

HTTP routes for Chatwarden, the open-source chat moderation kit for games. It gives you:

- the **staff API** (`adminRoutes`): the report queue, decisions, sanctions, rule gaps, term lists, policy documents, the editable moderation profile and the audit trail;
- the **player API** (`playerRoutes`): a player's notices, "my record", the rules, the code of conduct and a name check;
- **health probes** (`healthRoutes`);
- **signed webhooks**, outgoing (`webhooksOut`) and incoming (`webhookIn`);
- an **Express adapter** (`toExpress`, from `@chatwarden/http/express`);
- a **Web fetch adapter** (`toFetch`, from `@chatwarden/http/fetch`) for Next.js, Hono, Bun, Deno and anything else on `Request` and `Response`;
- a **`chatwarden` command** (`npx -p @chatwarden/http chatwarden init`) that writes the wiring for you, with the recipes in [`docs/recipes`](../../docs/recipes);
- a **browser-safe entry** (`@chatwarden/http/admin`): the staff API, `createRouter` and the error, role and permission exports, with nothing that imports a Node builtin, so a browser app can run the staff routes in the page.

The routes are plain functions over a small request and response type, so the package has no web framework in it. Express
(`toExpress`) and the Web `Request` (`toFetch`) are the adapters that ship; `createRouter` lets you write another.

Status: pre-release, as-is, no support promise.

## Install

```sh
npm install @chatwarden/http @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher
npm install express @types/express   # only for the Express adapter (peer dependencies, version 5)
```

Express 5 ships no types, so a TypeScript project that imports `@chatwarden/http/express` needs `@types/express` too: the
adapter's type declarations import from it. A plain JavaScript project can leave it out.

Node 22.13 or newer.

### CommonJS

The package is ESM only. A CommonJS app can still `require('@chatwarden/http')` on Node 22.13 or newer (and 24): Node loads an
ES module from `require()` as long as it has no top-level `await`, and none of the Chatwarden packages has one. On older
Node, use `await import('@chatwarden/http')`.

For types, a TypeScript project with `module: commonjs` and `moduleResolution: node` does not read the `exports` map, so the
`@chatwarden/http/express` subpath is found through `typesVersions` in the package's `package.json`, and
`import { toExpress } from '@chatwarden/http/express'` type-checks. `module: node16` or `nodenext` reads `exports` directly.
(TypeScript before 5.8 reports TS1479 when CommonJS code `require()`s an ES module under `node16`; use `nodenext` with 5.8 or
newer, or `await import(...)`.)

## The init command

`chatwarden init` writes the wiring for a moderated server into your project: the kit (engine, store and matcher), the mount for your framework, three starter hooks and a synthetic term pack. It can also write the chat box, the moderator hub and a Discord feed. Run it from the project root, the folder with `package.json`:

```sh
npm install @chatwarden/http @chatwarden/core
npx chatwarden init
```

With nothing installed yet, `npx -p @chatwarden/http chatwarden init` runs the same command.

It asks only what it cannot detect. With `--yes` it asks nothing. With `--json` it asks nothing and prints one JSON document. When the input is not a terminal it uses the detected answers and says so. It supports Express, Fastify, Next.js route handlers, anything on Web `Request` and `Response`, or the library alone (`--framework none`). The recipes in [`docs/recipes`](../../docs/recipes) show each result.

What it never does: it never edits a file that exists, it never writes outside the project folder, it uses the network only with `--install` (your package manager does), and it never writes a secret. A file that exists and differs is skipped (or, with `--on-conflict new`, written beside it with `chatwarden-new` in its name (`kit.chatwarden-new.ts`); with `--on-conflict overwrite` or `--force`, replaced). Running it again with the same answers changes nothing.

What it writes is a starter, and says so. Every starter hook carries a `TODO(auth)`, `TODO(identity)` or `TODO(terms)` marker. The staff routes answer 401 until `CHATWARDEN_ADMIN_TOKEN` is set to a long value, and production refuses to start without `CHATWARDEN_SECRET`. Run `npx chatwarden init --check` to list the markers still in your code and the required variable names that are not set. It changes nothing and exits 1 until nothing is left. A `.env` file is not loaded for you: export the names, or start your server with `node --env-file=.env`.

### Flags

This table is generated from the option list in the code, and a test checks it.

<!-- flags:start -->
| Flag | Values | Default | What it does |
| --- | --- | --- | --- |
| `--framework <value>` | `express`, `fastify`, `next`, `fetch`, `none` | detected, else express | Server framework to wire up |
| `--store <value>` | `sqlite`, `memory` | sqlite | Where moderation data is kept |
| `--chat <value>` | `none`, `box` | none | Add the kit chat box, or keep your own chat |
| `--chat-transport <value>` | `sse`, `socketio` | socketio if installed | How the chat box reaches the server |
| `--hub <value>` | `element`, `react`, `none` | react for next | How moderators open the hub |
| `--discord`, `--no-discord` | - | no | Post reports to a Discord forum |
| `--profile <value>` | `relaxed`, `standard`, `strict` | standard | How strict the standard is |
| `--base <value>` | - | /chatwarden | URL prefix everything lives under |
| `--dir <value>` | - | detected | Folder to write into, inside the project |
| `--lang <value>` | `ts`, `js` | from tsconfig.json | Language of the generated files |
| `--on-conflict <value>` | `skip`, `overwrite`, `new` | skip | What to do with a file that exists and differs |
| `--force` | - | - | Overwrite every file that exists and differs |
| `--install` | - | - | Run the package manager for you |
| `--dry-run` | - | - | Print the plan and write nothing |
| `--json` | - | - | Print one JSON document; ask nothing |
| `-y, --yes` | - | - | Accept detected answers and defaults; ask nothing |
| `--check` | - | - | Report what is still starter code; change nothing |
| `-h, --help` | - | - | Show this help |
| `-v, --version` | - | - | Show the version |
<!-- flags:end -->

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, or nothing to do. A dry run and a check that finds nothing wrong are 0 too. |
| 1 | A usage error (a bad flag, value or combination), an unsafe path, or `--check` found something left to do. |
| 2 | Applied, but some files were skipped because they differ. |
| 3 | Could not write a file, or the install failed. |

### `--json`

With `--json` standard output holds one JSON document and nothing else (child output of `--install` goes to standard error). Its keys, in order: `version` (the document's own, `1`), `chatwarden` (the package version), `ok`, `dryRun`, `answers`, `files` (each with a relative `path` and an `action`), `install`, `env` (names only, never values), `todo`, `nextSteps` and `warnings`, then `error` when something failed. It holds no secret and no absolute path.

### From your own code

`runCli(argv, env?)` from `@chatwarden/http/cli` runs the same command and returns the exit code, for a wrapper such as a `create-` package. Its names (`runCli`, `CliEnv`) are `@experimental` until 0.2, like every name this release adds.

## Set up

Copy this and change the two hooks (`authorize` for your moderators, `identify` for your players).

```ts
import express from 'express';
import { createChatwarden, type RawWho } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, healthRoutes, playerRoutes, webhookIn, webhooksOut, type KitRequest } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';

const store = openStore({ path: './chatwarden.db' });
const clock = { now: () => Date.now() };
const terms = new LiveTerms({ store, pack: yourTermPack, clock }); // see @chatwarden/matcher
await terms.load();

const cw = await createChatwarden({
  store,
  secret: process.env.CHATWARDEN_SECRET!, // keep it stable: it keys every stored hash
  platform: { identify: (ctx) => ctx as RawWho }, // how your server reads "who is this connection"
  matcher: terms,
  profile: 'standard',
});

const app = express();

// 1. The kit's routes FIRST. No body parser before them (see "Mounting").
app.use('/admin', toExpress(adminRoutes(cw, {
  // Your own moderator login. Return who is calling, or null for nobody (401).
  authorize: async (req: KitRequest) => {
    const staff = await lookupStaffFromSession(req.headers.cookie); // your code
    return staff === null ? null : { actor: staff.email, role: staff.role }; // 'moderator' | 'senior' | 'owner'
  },
  terms, // adds the term and exception routes
  gameName: 'My Game',
  contactUrl: 'https://example.com/appeals', // shown in the code of conduct
})));

app.use('/api', toExpress(playerRoutes(cw, {
  // Who is the player? Your session or device token. The kit hashes the key and keeps nothing raw.
  identify: (req: KitRequest): RawWho => ({
    clientKey: req.headers['x-player-token'],
    ip: req.remoteAddress, // the socket peer. Behind a proxy, see "Auth".
  }),
  gameName: 'My Game',
})));

// 2. Optional: the incoming webhook (a signed call from your own tooling).
app.use('/hooks', toExpress(webhookIn(cw, {
  secret: process.env.WEBHOOK_IN_SECRET!, // at least 32 characters
  actor: 'automation@example.com', // the audit actor for everything this route does
})));

// 3. Optional: tell a staff service about events (signed, retried).
const out = webhooksOut(cw, {
  endpoints: [{ url: 'https://staff.example.com/chatwarden', secret: process.env.WEBHOOK_OUT_SECRET!, events: '*' }],
});

// 4. Your own routes and body parsers go AFTER the kit's.
app.use(express.json());

// 5. The probes, last. A kit mounted at the root hands paths that are not its own to the next handler (`fallthrough`), so this
//    order is not required; it is the safe habit, and it makes the kit's 404 the last word (see "Mounting").
app.use(toExpress(healthRoutes(cw))); // GET /healthz, GET /readyz

const server = app.listen(3000);
process.on('SIGTERM', () => { out.dispose(); server.close(); void cw.close(); });
```

Try it:

```sh
curl http://localhost:3000/healthz                       # {"ok":true}
curl http://localhost:3000/api/rules                     # the rules, no login needed
curl -H "x-player-token: abc" http://localhost:3000/api/notices
curl -H "authorization: ..." http://localhost:3000/admin/reports
```

### The routes

Staff, under the prefix you mount (`/admin` above). Each one is authenticated, needs a permission (see Permissions below), and writes an audit row, except `GET /me` and the team routes (claims, take next, viewing, the change token and the saved reasons list), which write one only where a row means something: a takeover, and a change to the saved reasons.

| Route | What it does |
| --- | --- |
| `GET /me` | Who is calling: `{ actor, role, can }`, where `can` is a boolean for every permission under the table in force (your `permissions` overrides included). It needs only a signed-in caller, and writes no audit row. `features` (`@experimental`, new in 0.1.9) is `{ appeals, renames, keepBlocked, rooms, workflow, insights }`: appeals are on, renames can work (`names.renames` is on and the store can release one), `names.keepBlocked` is on, `rooms` (new in 0.2.0, always `true`: the room tools are part of every kit), `workflow` (`desk.workflow`) and `insights` (`desk.insights` and a store that can read the rows). It is always sent from 0.2.0. When you pass `community` (0.1.11), `features` also has `community: true`. |
| `GET /reports?status&reason&cursor&limit` | The queue, newest first, as summaries: `id`, `createdAt`, `roomId`, `tags`, `category`, `reportedReason`, `reportedReasonLabel`, `status`, `badFaith`, `targetPerson`, `reporterPerson`, `actionedAt`, `actionedBy`, `targetHandle`, `reporterHandle`, `claim`, `viewing`, `reporterAccuracy`, `ai`, and `boosted`. A report a chat filter filed (0.2.0) has `reporterPerson` and `reporterHandle` null, no reporter accuracy, and up to three more keys, `origin: 'filter'`, `originKey` (the counter key that made it, such as `link.unlisted`) and, for a phrase rule that is still in the settings, `originLabel` (its name, so a queue can say "Filter: Gold ads"); a player's report has none of them. `targetHandle` and `reporterHandle` are the reported person's and the reporter's handle as they were when the report was filed (null if none was recorded), so a row can show a name; they are staff-only, like the report page. `claim` is `{ by, since, until }` when another moderator (or you) is handling the reported person's case, else null, and `viewing` lists the other staff who have the case open right now (see the team routes below); both are empty for a report that is no longer open. `reporterAccuracy` is `{ decided, unfounded, falseRate, habitual }` for the reporter of an OPEN row: how their reports of the last 30 days turned out (`falseRate` is `unfounded / decided`, null below 5 decided reports; `habitual` is a rate of 0.8 or more). It is null on a decided row, when the reporter has no decided report in the window, when the store cannot tell, and for a caller whose role does not hold `history.read`. It is a ranking hint and a line on the case, never a reason to hide a report, and it never reaches a player. `boosted: true` (`@experimental`, new in 0.1.8) is on an OPEN row only when the queue signal feed (`feeds.queue`) is on, the person meets it and the caller's role holds `history.read`; with the feed off the key is absent and no store read is made. `ai` is the AI's brief of an OPEN report, `{ severity, confidence, rule, stale, injectionSuspected, hasRecommendation }` (the conduct level it read, how sure, the rule, whether it was read from older rules or an older version of the case, whether a line tried to instruct it, and whether it has a recommendation, which only level 2 counts), or null: on a decided row, when the AI is off or broken, and while a report has no read yet. No summary and no line ids. No chat text or notes. `reportedReason` is the reason the reporter gave (an id from the profile's reporting reasons; an old category reads as its new id, `disruption` as `griefing`), or null; `reportedReasonLabel` is its label as it is now (the id when the reason has since been removed, null when none was given). It is a hint, never the truth. `reason` filters on it: a reason id (the old `disruption` finds `griefing`), or `none` for the reports that gave no reason; a malformed value is 400 `invalid_query`, and an id nobody used is an empty page. |
| `GET /reports/:id?level` | One report with its excerpt, notes, each person's history and a suggestion. Each excerpt line that a person wrote themselves carries `noticeText` (`@experimental`): the text that person's notice would show for it, with only blocked terms starred, never the raw line. This is where evidence is read, so it is audited with the report id. The answer is `{ report, history, suggest, rule, claim, ai, aiExpected? }`. `report` also has `reportedReasonLabel` beside `reportedReason`, and `detailAt` (when the reporter added their follow-up, or null). `rule` is the first still-citable rule of the reported reason, or `"uncovered"` when no reason was given (the moderator picks). `claim` is the claim on the reported person's case (`{ by, since, until }` or null). A claim never stops anyone reading. `ai` is null, or the AI's read: `{ id, severity, rule, summary, evidenceLineIds, confidence, stale, injectionSuspected, model, at, recommendation }`. `recommendation` is null at level 1, and at level 2 `{ verdict, severity, rule, evidenceLineIds, step, stepWithinCeiling }`: `step` is what the ladder suggests for the AI's conduct level, computed now (`{ kind, durationMs, label }`, or null for no action), and `stepWithinCeiling` is true when it is a note, a warning or a restriction of at most 24 hours with a line by the reported person cited, which is all a one-key accept may fill. Opening a case with no read, or a stale one, queues a read; the answer is whatever is stored now, and never an error. `aiExpected` is a boolean that is present only while the AI is on (level 1 or 2): true when a read of this report is on its way (an adapter is set up, the breaker is closed, neither daily limit is reached and the read has not ended without an answer), false in those degraded cases. The hub waits for a read only when it is true; with the AI off the answer has no such key. New in 0.2.0 (`@experimental`): `evidence: { ref, url } | null` (the game's evidence id and the link built from `reporting.evidenceUrl`, `url` null with no usable `https` template; the raw `evidenceRef` is not in the body), `surge: { reports, reporters, windowMinutes, newAccounts, newAccountDays }` (only with `desk.surge` on and the person over its threshold: a hint, never a reason to set a report aside), and on each excerpt line `retracted` (taken back for everyone, before or after the report was filed) and `removable` (still in the evidence buffer, delivered and not yet taken back). |
| `POST /reports/:id/suggest` | `{ level, rule?, person? }`: a suggestion for a person the report names (default: the reported person). When a signal ladder rule (`feeds.ladder`) fired it also carries `signals: { raised, ids }` and the rule's sentence is in `why` (`GET /reports/:id` carries the same in its `suggest`); both only for a caller whose role holds `history.read`, because the sentence is a count of what other players did. A caller without it gets the same outcome and label, and no `signals` key and no such sentence. |
| `POST /reports/:id/decide` | `{ verdict, actions, reason?, evidence?, rename? }`. `rename: { rule }` (`@experimental`) also asks the reported person to choose a new name, with the decision's reason kept in the audit trail only: the verdict must be `upheld`, any actions must be on the reported person, the caller needs `sanctions.apply` and `names.renames` must be on (400 `invalid_request`, 403 or 404 before anything is written). The decision is written exactly as without it (the rename is not part of its idempotency); then the rename is asked, the answer gains `rename: { status: 'asked' | 'already' | 'failed', error? }` (`already`: a request is still waiting, or, on a replay, one was asked at or after the decision was written, even if the player has renamed since: a replay never asks twice; `failed`: the decision stands and the rename was not asked, `error` is `off`, `not_found` or `invalid` when the core refused it) and the ask is audited `name.rename_required`. `reason` is required (1 to 500 characters), except for a `no_action` with no actions, a one-click dismissal: leave it out (or send it blank) and the report is closed with the standard reason `No action needed`. A `no_action` that acts on someone, and every other verdict, still needs a real reason (400 `invalid_request`). A replay of the same decision applies nothing twice. If another moderator holds a live claim on the reported person, the answer is 409 `claimed` (with `by` and `until`) and nothing is written, unless the body also has `takeOver: true` and the caller holds `claims.override`: then the case moves to the caller, an audit row `case.takeover` is written first, and the decision goes ahead. A successful decision of the person's last open report releases the caller's own claim; while other reports about the same person are open the claim is kept untouched (one case per person), so nobody else can take the case from the moderator working through it. The body may also carry `ai: { readId, accepted, severity? }`: the AI read the moderator was shown (`ai.id` of the report page), whether they accepted its pre-fill in one click, and the conduct level their form settled on. The server records how the decision compared with the report's AI read (agree, override or none) in the same transaction for every decision on a report that has a read, with or without `ai` (and so for a bulk dismissal or a webhook decision), and writes an `ai.outcome` audit row as the caller; the echo never changes the decision or the answer, and agreement is never taken from it. `readId` names the read the moderator saw (one of this report's finished reads; any other id falls back to the newest). `accepted` is a claim: it counts as a one-click only when the decision is the pre-fill (the same verdict, rule and kind of step, no longer). `severity` counts only when it fits the verdict (a dismissal carries none, an action is not `banter`). Without `ai` the row keeps no click and no example text. A malformed `ai` (or any other key in it) is 400 `invalid_request`; a `readId` that names no read is ignored. |
| `POST /reports/dismiss-open` | `{ scope, ref, takeOver?, dryRun? }` where `scope` is `person` or `reporter`. "Nothing wrong here" for every open report about the person `ref` (their case, merged aliases included) or filed by the reporter `ref`, in one call. At most 200 reports a call: `more: true` says there are more, and running it again finishes them (a retry is safe). Answers `{ ok, dryRun, open, dismissed, replayed, skipped: { claimed, decided }, more }`: counts only, never a report id or a person. Each report is closed like a single `no_action` decision with no actions and the standard reason `No action needed` (a `reason` is not accepted; any unknown key is 400 `forbidden_key`), so a sweep never marks bad faith and never counts toward a reporter's suspension. Person scope behaves like a decision: another moderator's live claim is 409 `claimed` unless `takeOver: true` and the caller holds `claims.override` (audited `case.takeover`, first). Reporter scope spans many cases and never takes one over: cases held by someone else are skipped and counted in `skipped.claimed` (`takeOver` is not accepted). The caller's own claim ends on a case with nothing left open. `dryRun` counts (claimed cases included) and writes nothing. An unknown ref answers 200 with zeros. Audited: one `report.dismiss_case` (target the person) or `report.dismiss_reporter` (target the reporter) row first, written before anything is closed (a sweep that cannot be recorded does not happen: 500), then one `report.decide` row per report closed (best effort, written as each one closes, so a store failure partway through still leaves a row for every report already closed; a replay is audited too, like the single decide route). Cases held by others stay open and are counted, so `more: true` with `dismissed: 0` means the rest are held, not that running it again helps. Needs `reports.decide.bulk` and `reports.decide`. |
| `GET /rooms` | `{ rooms: [{ roomId, tags, seated, mode, until }] }`: the rooms this process knows (seated players, or a mode set), up to 500, the most seated first. No seat id, handle or text. Needs `rooms.read`; no audit row. `@experimental`, new in 0.2.0. |
| `POST /rooms/:room/mode` | `{ mode, forMs? }` and nothing else: `normal` (clears at once), `locked` (only staff may chat) or `emergency` (slow mode, new accounts read-only); every mode but normal ends by itself after `forMs` (60 000 to 86 400 000, default `rooms.defaultModeMs`). 200 `{ mode, since, until }`; 400 `invalid_mode`, `invalid_value` (a bad length) or `invalid_request` (a bad room id, key or shape: the room id is any text of 1 to 128 characters without a control character, sent percent-encoded). Needs `rooms.manage`; audited `room.mode` on the room (`h-` and a keyed hash when the id is not a valid ref), REQUIRED and written BEFORE the change, normal included: a failing audit write is a 500 and changes nothing. Per process and in memory. `@experimental`, new in 0.2.0. |
| `POST /rooms/:room/lines/:line/retract` | Nothing, or `{ allFromAuthor?: boolean }`. Takes the line (or every delivered line of its author still in the evidence buffer) back for everyone, keeping it as evidence. 200 `{ count }`; 404 `not_found` for a line that is too old, gone, already taken back or unknown (one body for all). Needs `rooms.manage`; audited `room.retract` on the room, REQUIRED and written before the retraction. Not a sanction: nothing is said to the author. `@experimental`, new in 0.2.0. |
| `GET /people/:ref/links` | `{ accounts, devices, merged, inForceOnLinked: { ban, area, chat } }`: counts only (account ids and client keys the kit holds for the person, subjects merged into them, and the sanctions in force placed on a merged subject rather than their own). Never an id, key, hash or address; a hint, not proof (a shared device can link two people). 404 `not_found` for a ref the kit holds nothing for. Needs `history.read`; audited `history.view` on the person. `@experimental`, new in 0.2.0. |
| `GET /people/:ref/history` | `{ history, reports, sanctions, asReporter, handle }`, and `signals` (`@experimental`, new in 0.1.8) when the record feed (`feeds.record`) is on: `[{ kind, label, polarity, distinct, weight, windowDays, firstAt, lastAt }]` for the chosen kinds and window, `[]` when none qualifies, and no key at all when the feed is off. No `by`, room or row is in it. `handle` is the person's handle on the newest report filed against them that recorded one, or null. `history` and `reports` are the person's counted actions and the recent reports against them. `sanctions` is a list of sanction groups, newest first: the last 90 days plus every group still in force (a permanent one that has not been revoked, or a restriction that has not ended), at most 200 (the groups in force are always kept; the cap trims the oldest of the rest), each `{ groupId, refCode, kind, rule, startsAt, endsAt, reason, actor, source, automated, active, pending, revokedAt, revokedBy, revokeReason }`. `rule` is a rule number, `"uncovered"`, or null on a row written before rules existed; `endsAt` is null for a permanent sanction and for a warning or note (which have no end); `active` is about time and revocation only: true while a restriction has started, is not revoked and is not past its end, and for a warning or note while it is inside the 90-day window the escalation ladder counts; `pending` is true when the sanction was written while enforcement was off, so it applies nothing until enforcement is on (a hub can label it; it does not change `active`); the revoke fields are null until someone revokes it. A group is built from the person's own row, so no IP, hash or stored value is ever part of it. `asReporter` is how the reports this person *filed* stand: `{ reports, open, actioned, dismissed, badFaith, suspendedUntil, reasonMatched, reasonDecided }`, where `suspendedUntil` is the epoch ms their reporting suspension ends (`limits.reports`: that many bad-faith dismissals inside the window), or null, and `reasonMatched` of `reasonDecided` is how often the reason they gave was borne out by the decision (see the core README, "Reporting settings"). New in 0.1.9 and `@experimental`: `appeals` (the person's appeals as in `GET /appeals`, without the statement; only for a caller who holds `appeals.read`) and `renames` (`[{ at, pending }]`, one for each rename requested) are added while the feature is on or the person has any, and are otherwise absent. Both stay visible after the feature is switched off, until retention removes them. New in 0.1.13 and `@experimental`: `automation` (`{ code, at }`), only while a senior has marked the person "do not automate" (never who). |
| `GET /sanctions?cursor&limit&source` | Every person's sanctions, newest first, `{ items, next }`: the same group object as above plus `person` (the canonical subject, a staff ref) and `handle` (the handle on the newest report filed against that person that recorded one, or null). `limit` is 1 to 200 (default 50, a bigger number is clamped), `cursor` is the previous `next` (null on the last page; a full page always carries one, so the page after an exactly-full last page is empty), `source` is one of `moderator`, `auto_filter`, `coop`, `api`, `ai`. A bad limit, cursor or source is 400 `invalid_query`. Not windowed. It audits `history.view` with no target, once per successful read (a page, a filter and a second look are each a row), as `GET /people/:ref/history` does for one person; a refused read (400, 403) writes none, and if the row cannot be written, the read fails (500) and returns nothing. |
| `GET /blocked?days=1\|7\|30` | The chat lines the slur filter blocked, newest first, at most 500: `{ items: [{ id, at, roomId, termId, term, language, person, handle, text }] }`. `days` defaults to 7; any other value is 400 `invalid_query`. `text` is the line exactly as the person typed it and `person` the canonical subject: staff only. `handle` is the name to show for them (the newest non-blank handle on a report filed against them), null when none recorded one or when the caller lacks `history.read`. `term` and `language` come from the `terms` you passed, and only when the caller also holds `terms.read` (the term text is that permission's); they are null without `terms`, for a term no longer listed, or for a caller who lacks `terms.read`, and `termId` and `text` are still there. The kit keeps these lines 30 days. Staff already read raw lines in a report's excerpt, so this is not a new kind of exposure, but it is a new way to reach it: it has its own permission, `blocked.read`, and writes an audit row, `blocked.view` (no target). `source=name` (`@experimental`, new in 0.1.9) lists the blocked NAMES kept as evidence (`names.keepBlocked`) instead: the same items with `text` the name as typed, `roomId` null, `reason` (`name_not_allowed` or `name_profane`) and `person` null when the check could not tie the name to someone; empty (still 200) when none was kept. Any other `source`, or none, is the chat lines, as before. |
| `GET /appeals?status&cursor&limit` | The appeals inbox (`@experimental`, new in 0.1.9), oldest first: `{ items, next }`. `status` is `open` (the default), `decided` or `all`; `limit` is 1 to 200 (default 50); `cursor` is the previous `next`; a bad value is 400 `invalid_query`. An item is `{ id, createdAt, status, person, sanction: { groupId, refCode, kind, rule, startsAt, endsAt, decidedBy, automated }, statementFlagged, handle }`, with `handleFlagged` as below; its `status` is `open`, `upheld`, `reduced`, `revoked` or `moot`. **No statement is in a list.** 404 `not_found` while appeals are off. Needs `appeals.read`; audited `appeal.view` with no target. |
| `GET /appeals/stats?days=30\|90\|365` | `{ windowDays, perRule: [{ rule, sanctions, appealed, granted, lightened, rate, band }], overall }`. `granted` counts revoked appeals only: a reduction is `lightened` and is never a false positive. `rate` is `granted` over `sanctions`, `null` below 10 sanctions; `band` is `normal`, `elevated` (from 0.15) or `high` (from 0.30). `days` defaults to 90, and any other value is 400 `invalid_query`. Needs `appeals.read`; audited `appeal.view` with no target. |
| `GET /appeals/:id` | `{ appeal }`: the summary and `statement` (the player's own words, `null` once retention has cleared it), `decided` (`{ by, at, reason, replacementGroupId }` once decided, the reason private to staff), `reportId` and `shown` (the lines the player was shown, as `{ text, day }`). 404 for an unknown id. This is where a statement is read, so the read is audited with the appeal id (`appeal.view`, required). Needs `appeals.read`. |
| `POST /appeals/:id/decide` | `{ outcome, reason, to? }`: `outcome` is `uphold`, `reduce` or `revoke`; `reason` is private, 1 to 500 characters and never echoed; `to` is `{ kind, durationMs }` and goes with `reduce` only (with `customDuration` off the length must be one the profile offers, else 400 `duration_not_offered`). 200 `{ status, replacementGroupId? }`. 409 `already_decided`, `same_decider` or `gone`; 400 for a body the kit refuses; 404 for an unknown id or while appeals are off. The actor is the signed-in caller, never the body. Needs `appeals.decide`; audited `appeal.decide`, best effort after the write. |
| `POST /people/:ref/rename` | `{ reason, rule, takeOver? }`: ask a player to choose a new name (`@experimental`, new in 0.1.9). It is not a sanction: no length, no appeal, nothing on "My record". `reason` is private, 1 to 500 characters; `rule` is required (a rename always cites a rule) and an active whole-number rule. 200 `{ ok: true }`. 404 `not_found` while renames are off, when the store cannot release a rename, or for a person the kit does not hold; 409 `pending_rename` while an earlier request is waiting for the game to release the player; the claim rules and `takeOver` are those of `POST /sanctions`. Needs `sanctions.apply`; audited `name.rename_required`. Your game hears `rename.required` (see Webhooks). |
| `POST /reports/:id/ai/read` | "Read again", behind the AI details menu. 200 `{ status: 'ready', ai }` when nothing the AI reads has changed since its last read (no call is made), 202 `{ status: 'pending' }` when a read is queued (fetch the report to see it; a read that ended without an answer, such as a refusal, is retaken once by an explicit ask, charged to the spend), 409 `ai_off` (the AI is at level 0, not set up, or the report is decided; no audit row), 409 `ai_final` (the read for this input ended without an answer and was already retaken once: there is nothing more to try), 429 `ai_budget` (the daily limit in money, set in code, or in calls, set by the owner), 429 `rate_limited` (10 a minute per caller, counted in each process) or 503 `ai_unavailable` (the provider is failing and the breaker is open, or the minute's calls are used; the body also has `retryAfterMs` and the `retry-after` header says the same in seconds). 404 for an unknown report. Needs `reports.decide`; audited `ai.rerun` before the call is made (a row that cannot be written is a 500 and no call), so every answer after `ai_off` leaves one row, a limited click included. |
| `POST /reports/:id/ai/dont-teach` | A senior's mark on a decided report: its casebook row can never be a prompt example again, and its example text is dropped. 200 `{ ok: true }`; 404 when the report is unknown or has no casebook row (it was not decided with the AI on). Needs `reasons.write`; audited `ai.outcome`. |
| `GET /ai/status` | Where the AI stands: `{ available, level, maxLevel, state, spentMicros, capMicros, capCalls, day, reads, cacheHitRate, invalid, learn, stats }`. `available` is false without an adapter in code (then `level` is 0). `level` is the setting held to `maxLevel`; `state` is `ok`, `paused_budget` (the daily limit, resumes 00:00 UTC), `unavailable` (the provider is failing; the breaker is open) or `off`. `spentMicros` and `reads` are today's (UTC) from the store, in micro-dollars and calls, against `capMicros` (set in code) and `capCalls` (the owner's `ai.dailyCalls`, 5 000 by default); `paused_budget` is either one reached. `cacheHitRate` is the share of input tokens the provider cached, over this process's calls, or null. `invalid` counts the answers core refused, by code, since the process started. `learn` is the "learn from our decisions" setting. `stats` is the casebook: `{ since, decided, agree, override, none, falsePositives, oneClick, agreementRate, falsePositiveRate, oneClickRate, rules: [{ rule, decided, agree, override, none, falsePositives, oneClick }] }` over the last 30 days. The level itself is set with `PUT /policy/profile` and `layer.ai: { level, learn, dailyCalls }` (`dailyCalls` is a whole number from 1 to 100 000). Needs `policy.read`; audited `policy.view`. |
| `POST /sanctions` | `{ subject, kind, durationMs, rule, reason?, gapNote?, includeIp? }`. `durationMs` is required: milliseconds up to 365 days, or `null` for permanent. When the profile has `customDuration` off, a length that is not in `durations`, not one of the profile's own lengths (the ladder, the first offences, the repeat rule) and not permanent is 400 `duration_not_offered`; a decision's actions are checked the same way. Answers `{ groupId, refCode }`. A live claim by another moderator on `subject` is 409 `claimed`, as for a decision, and `takeOver: true` works the same way (the claim then stays with the caller). Revoking is never held up by a claim. |
| `POST /sanctions/:groupId/revoke` | `{ reason }` (a non-empty string; blank is 400). Revokes the whole group. 404 if it is unknown or already revoked. |
| `GET /gaps` | Rule gaps (sanctions filed under no rule), newest first. Returns the moderator-written gap notes in bulk, so moderators must never paste chat into a gap note. |
| `POST /gaps/:groupId/close` | `{ status, ref }`: `status` is `ruled` (with `ref`, the number of the active rule that now covers it) or `not_a_rule` (`ref` null or absent). |
| `GET /terms` | `{ terms, exceptions, blocks30d }`: the rows, text included, each with `note`, `addedBy`, `addedAt`, `updatedBy` and `updatedAt` (null when unknown), and `blocks30d`, a map from every listed term id to how many lines it blocked in the last 30 days (0 for none; the map has no prototype, so any id is an ordinary key). Only when you pass `terms`. |
| `POST /terms/check` | `{ term, language }`: a dry run, answers `{ hits }`. |
| `POST /terms/test` | `{ text }`: would the live list block this chat line? Answers `{ verdict, termId }`, where `verdict` is `blocked` (with the id of the term that matched), `clean` (`termId` null) or `too_long` (the line is longer than `limits.chatMaxLength`, 200 by default, after trimming; it is not checked). It changes nothing: no strike, no audit row, no rate charge. Only when the `terms` you passed has a `match` (a `LiveTerms` does). |
| `POST /terms` | `{ term, language, note? }`. `PATCH /terms/:id` takes `{ term?, language?, note? }`; `POST /terms/:id/active` takes `{ active }`. |
| `POST /exceptions` | `{ phrase, language, note? }`. `PATCH /exceptions/:id` and `POST /exceptions/:id/active` work like the term ones. |
| `POST /cases/:ref/claim` | `{ takeOver? }` (the body is optional). Claim the case of the person `:ref` (a staff ref; an alias is the surviving person) or beat your own claim, which is a heartbeat: answers `{ claim: { by, since, until }, tookOverFrom: string \| null }`. A claim lasts 10 minutes from the last beat, on the kit's clock, and is held by the person, so every report about them is one case. 404 `not_found` when the person has no open report. 409 `claimed` with `{ error, message, by, until }` when another moderator holds it and `takeOver` is absent, or the caller lacks `claims.override`. Only moving somebody else's live claim is a takeover; it writes an audit row `case.takeover` (target the person) first, and if that row cannot be written the answer is 500 and nothing moves. The row means the takeover was attempted: if the person's last open report closed in between, the answer is 404 and nothing moved. A claimer who loses a race with another server process on a shared database is retried (up to 3 attempts, each with a fresh read) and gets the normal 409. An ordinary claim writes no row. `takeOver` must be a boolean (else 400). Needs `reports.decide`. |
| `POST /cases/:ref/release` | Releases your own live claim: `{ released: boolean }`. Another moderator's claim, no claim and a lapsed one are all `{ released: false }` (200), so it is safe to call twice. Needs `reports.decide`. |
| `POST /cases/next` | `{ category?, reason? }` (the body is optional). Claims and returns the oldest open case that nobody holds (with the queue signal feed on, a boosted case first: the hub asks for this through `signalBoost`, and an overdue case still comes before it), `{ case: { person, reportId, claim } }`, or `{ case: null }` when there is none. A case is ordered by the person's oldest open report and opens on their newest (`reportId`); a case anyone holds, you included, is skipped without a write; `category` (one of the report categories, else 400) keeps only cases with an open report of it. `reason` (a reason id, the old `disruption` finding `griefing`, or `none` for reports that gave none; a malformed one is 400) keeps only cases with an open report that gave it; give both and both must hold. They are the only filters: the order is already oldest first, and there is no wait filter. A case whose open reports all come from habitual false reporters (a false-report rate of 0.8 or more over at least 5 decided reports in 30 days) and none of which has waited 24 hours is served after the ordinary ones, never skipped, so a queue holding only such cases still serves them, oldest first. Two moderators asking at once never get the same case. Needs `reports.decide`. |
| `POST /cases/:ref/viewing` | A heartbeat that you have the case open: `{ viewers: string[] }`, the other staff who do. A beat counts for 30 seconds. It is a hint kept in this server process's memory, never stored and never a lock, so a second server process does not see it. 404 `not_found` when the person has no open report (nothing is tracked, so made-up refs fill nothing), and one actor keeps at most 20 cases open: a newer beat drops their oldest. Needs `reports.read`. |
| `GET /changes?since=<token>` | `{ token, changed, urgent }`: a cheap check for a queue that polls. `token` is opaque (compare it, do not parse it); `changed` is false only when `since` is exactly the current token. It differs after a report is filed or decided, a sanction is applied or revoked, a rule gap is closed, a claim is taken, taken over or released, or a saved reason changes. A claim heartbeat, a claim that merely lapses, viewing and every read leave it alone. The token is kept in the store, so a restart does not rewind it and several server processes agree. One read, no audit row. `since` that is not a short token is 400 `invalid_query`. Needs `reports.read`. `appeals` (`@experimental`, new in 0.1.9), the number of open appeals, is added only while appeals are on and the caller holds `appeals.read`. `urgent` (`@experimental`, new in 0.2.0) is how many open reports are urgent, always present. `asked: { senior, owner }` (`@experimental`, new in 0.2.0), the open reports asked of each role, only with `desk.workflow` on. |
| `GET /reasons` | `{ reasons: [{ id, label, text, active }] }`, in the order they were added, switched-off ones included (a picker shows the active ones). Needs `reasons.read`. |
| `POST /reasons` | `{ label, text }` (trimmed; the label is up to 40 characters and the text up to 500, counted as characters so an emoji is one; at most 200 reasons; a label may hold no control character, a text none but a newline): answers `{ reason }`. Audited `reason.add` on the reason id. `PATCH /reasons/:id` takes `{ label?, text? }` (at least one) and `POST /reasons/:id/active` takes `{ active }`; both answer `{ reason }` and 404 for an unknown id, and are audited `reason.update` and `reason.toggle`. Need `reasons.write`. |
| `GET /policy?format&omit` | The code of conduct, moderator guide and agent brief, generated from your profile and rules, and `notices: { reporterFeedback }` (`@experimental`: whether an upheld decision thanks the reporter). `omit=rules,ladder` leaves those sections out of the moderator guide (a UI that draws them from the data uses it); an unknown name is 400 `invalid_query`. |
| `GET /policy/contexts` | The room contexts the profile declares (they are set in code, never in the hub): `{ contexts: [{ name, label, overrides }] }` in declaration order, where `label` is the one on the case chip (the name when none was given) and `overrides` lists the sections the context sets (`profanity`, `pace`, `chat`, `filters`): names only, never a value. `[]` when none is declared. Needs `policy.read`; 403 for a scoped caller; writes no audit row. `GET /reports/:id` carries `context` (the room's `context` tag as written, or `null`) and a queue row carries it for a room that had one. |
| `GET /policy/profile` | The editable moderation profile: `{ effective, base, layer, version, canSave, limits }`, where `limits` (`@experimental`, new in 0.1.8) is read only and not part of the layer: `{ chatRate: { count, windowMs }, signalsMs }`, the kit's chat rate limit actually in force and how long signal rows are kept (the longest window a feed may look back); a server older than 0.1.8 sends none, and the answers to `PUT` and `DELETE` carry it too. Plus `layerError` (`{ path, kind }`) when the stored layer cannot be used and is being ignored (`kind` is `unreadable` for stored text that could not be read at all, `invalid` for one that was read but is not valid), and `dropped` (`[{ feed, reason }]`) when a stored signal feed could no longer be used and was left out of `layer` (a feed name and a reason code only; `layer` is then the layer in force, and sending it back in a `PUT` is accepted). `effective` is what is in force (`base`, the profile from your code, with the owner's stored `layer` on top); `version` is the layer's version (0 when nothing was ever saved). `canSave` is false when your store cannot save settings. It looks at the store first, so it is never behind another process. Needs `policy.read`; audited `policy.view`. |
| `PUT /policy/profile` | `{ layer, version, reason }`: replace the stored layer, the whole layer (a section left out goes back to the base). `layer` may hold `durations`, `customDuration`, `ladder` (all 6 rows; a cell without a `label` gets one, such as "Restrict chat 6 hours"), `firstOffense`, `repeat`, `areaRules`, `severeRules`, `guidelines` (`[{ outcome }]`, one entry per tier, `null` to keep a tier) and `reporting` (`{ flow?, reasons?, thanks? }`: the report flow, the whole ordered list of reasons, each `{ id, label, hint?, group?, rules?, asksNote?, enabled? }`, and the thank-you copy; the audit section is named `reporting`), and, as the hub's Advanced screens save them, `ai`, `pace`, `signals`, `appeals` (`{ enabled?, perPlayerPerWeek?, allowSelfReview? }`, new in 0.1.9) and `names` (`{ profanity?, keepBlocked?, renames?, maskInHub? }`, new in 0.1.9); anything else, profanity included, is refused. `version` is the one you loaded; `reason` is 1 to 2000 characters. 200 `{ ok, changed, effective, base, layer, version, canSave }`: `changed` names the sections that differ, and the rest is the fresh state in the shape `GET` answers, so no second read is needed; it takes effect at once here and within 10 seconds in other processes. 409 `conflict` when someone saved since you loaded (reload and merge). 400 `invalid_profile` with `path` (the field in your layer, such as `layer.ladder[2].high.durationMs`) for a layer the kit refuses. 501 `not_supported` for a store that cannot save settings. Needs `policy.write`; audited `policy.update` with the sections changed and the reason, never the values. |
| `POST /policy/profile/preview` | `{ layer, rule? }`: what the candidate layer would suggest, `{ samples }`, for four fixed records (`clean`, `oneWarning`, `chat24h`, `ban7d`) at each conduct level, each as `{ label, kind, durationMs }`, and `reporting`, what a player would read of the candidate's reporting settings (the enabled reasons without any rule mapping, the flow and the thank-you) (`durationMs` is null for permanent and for a warning or note). Saves nothing and writes no audit row. `rule` is a Community Rule number, to see `areaRules` or `severeRules` take effect. An invalid layer is 400 `invalid_profile` with `path`. Needs `policy.read`. |
| `GET /insights?days` | How the team is doing over the last 7, 30 (default) or 90 days, with `desk.insights` on (off: 404 `not_found`): `{ days, from, to, reports: { filed, decided, open }, decision: { decided, medianMs, p90Ms }, urgent: { filed, decided, medianMs }, wait: { longestOpenMs, backlog }, byReason, byOutcome, byRule, chat, partial }`. Counts and times only: no person, handle, text or staff member, and never a per-person number. `medianMs` and `p90Ms` are `null` below 5 decided reports (`urgent.medianMs` below 3); `chat` (`delivered`, `refused`, `reportsPer1000`) is `null` when no line was counted in the window and its `reportsPer1000` is `null` when none was delivered or counting began inside the window; `partial` is true when the read hit its 20 000-report cap inside the window, or an open report is older than the 90 days the read takes (or was cut by the cap): the longest wait still counts it, the open count does not. `byRule` is `null` (not an empty list) when the store cannot count sanctions by rule. Any other `days` is 400 `invalid_query`. Needs `insights.read`; audited `insights.view` with no target, best-effort. `@experimental`, new in 0.2.0. |
| `GET /filters/stats?days` | What the chat filters did over the last 7 or 30 UTC days (today included), `{ days, keys }`: per counter key (`link.unlisted`, `personal_info.phone`, `phrase.<id>`, `ratio.caps`, ...) the counts by the action applied, `{ count, flag, mask, refuse, flag_capped }` (`flag_capped`: the daily cap turned a flag into a count), and for a phrase key also `label`, the rule's label as it is now. No person, room or text. Any other `days` is 400 `invalid_query`. Writes no audit row. Needs `filters.read`. `@experimental`, new in 0.2.0. |
| `POST /filters/test` | `{ text, candidate? }`: the verdict for one line, `{ verdict, delivered }`: every hit with its kind, detail, action, Community Rule and matched ranges (`spans`), the refusal if there is one, and the line as it would be delivered (`null` when refused), under the settings in force or under `candidate` (filter settings that are not saved). `text` is 1 to 2000 characters. A candidate the kit refuses is 400 `invalid_filters` with `path`. Nothing is stored, counted, audited or logged. Needs `filters.read`. `@experimental`, new in 0.2.0. |
| `POST /filters/check` | `{ candidate }`: the candidate over the `recentLines` you passed (none: empty counts), `{ lines, refused, masked, rules }`: at most 5000 lines read, and for each rule the lines it hit (`hits`) and up to 20 `samples` with their ranges. 400 `invalid_filters` with `path` for a candidate the kit refuses. Nothing is stored, counted or audited. Needs `filters.read`. `@experimental`, new in 0.2.0. |
| `POST /privacy/find` | `{ accountId }` and nothing else: `{ ref }`, the person's staff ref, or `{ ref: null }`. Finds by the game's account id and creates no one. The owner's, fixed in code (a `permissions` override cannot lower it). Audited `privacy.find` with no target (the account id is never written down), best-effort. `@experimental`, new in 0.2.0. |
| `GET /people/:ref/privacy/export` | Everything the kit holds about the person (the canonical subject and every alias) as one JSON attachment (`content-disposition: attachment`, `no-store`): `cw.privacy.export`. No hash, no other player, no reporter or staff reference. 404 `not_found` for a person the kit does not hold. The owner's. Audited `privacy.export` on the person, and the audit is required: when the row cannot be written nothing is exported (500). `@experimental`, new in 0.2.0. |
| `POST /people/:ref/privacy/erase` | `{ keep: 'safety' or 'none', confirm, dryRun? }` and nothing else (an actor is never read from the body): erase the person, `cw.privacy.erase`. `confirm` must equal the person's canonical ref (400 `confirm_mismatch`); 400 `invalid_request` for a bad `keep` or an extra key; 404 `not_found` for an unknown person. With `dryRun: true` the body is `{ dryRun, mode, removed, kept }` and nothing is written, audited or counted. Otherwise the body is the receipt, `{ id, at, mode, removed, kept, auditFailed? }`: counts and words only. The core audits `privacy.erase` after the commit; a failed audit is `auditFailed: true` and never undoes the erase. The owner's. `@experimental`, new in 0.2.0. |
| `GET /privacy/statement` | What the kit keeps and for how long, category by category with the retention in force (`cw.privacy.statement()`), for the hub and your own policy text. The owner's. No audit row. `@experimental`, new in 0.2.0. |
| `PUT /reports/:id/hold` | `{ code }` and nothing else, with one of `law_enforcement_request`, `legal_proceeding`, `platform_request`, `safety_review`, `other` (400 `invalid_request` for anything else: there is no free text). Holds the report so no retention purge and no erase reaches it or what hangs on it; emits `report.escalated`. 200 `{ ok: true }`; 404 `not_found`; 409 `already_held`. Needs `legal.hold`. Audited `legal.hold` on the report, best-effort after the write. `@experimental`, new in 0.2.0. |
| `POST /reports/:id/urgent` | `{ on: boolean }` and nothing else (400 `invalid_request` otherwise). Marks an open report urgent or not urgent (a report is also urgent from its reason's flag, a snapshot taken when it was filed). 200 `{ ok: true }`, also for a repeat; 404 `not_found`; 409 `already_decided`. Needs `reports.urgent`. Audited `report.urgent` on the report, best-effort after the write. `@experimental`, new in 0.2.0. |
| `POST /reports/:id/handoff` | An empty body, or `{ takeOver?: boolean }`. Marks the case as passed to the game's safety team: who and when, the first mark only (a repeat is `{ ok: true }` and changes nothing); emits `report.handoff` (the report id and the time). It honours another moderator's claim like a decision (409 `claimed`; `takeOver` needs `claims.override` and is audited `case.takeover` first) and contacts no one. 404 `not_found`; 409 `already_decided`. Needs `reports.handoff`. Audited `report.handoff` on the report, best-effort after the write. `@experimental`, new in 0.2.0. |
| `POST /reports/:id/comments` | `{ text }` and nothing else. Adds a staff comment (1 to 500 characters after cleaning: control, bidi and zero-width characters removed; at most 50 entries a report). 200 `{ comment: { id, at, author, role, kind, text } }`; 400 `invalid_request`; 404 `not_found`; 409 `comment_limit`. Never claim-gated. Needs `reports.comment`; audited `report.comment` on the report (no text), best-effort. With `desk.workflow` off every workflow route is 404. `@experimental`, new in 0.2.0. |
| `DELETE /reports/:id/comments/:cid` | Removes a comment: its author, or a senior or the owner; another moderator's comment and an unknown id are the same 404. 200 `{ ok: true }`. Needs `reports.comment`; audited `report.comment_remove`, best-effort. `@experimental`, new in 0.2.0. |
| `POST /reports/:id/escalate` | `{ to: 'senior' \| 'owner', note? }` and nothing else. Asks a senior or the owner for a second look (an owner asks no one: 403 `forbidden`): a flag, an `ask` or `escalate` entry in the thread, and `case.escalated` (ids, the role asked and a time). It changes no claim and no order. 200 `{ ok: true }`; 400; 404; 409 `already_decided`. Needs `reports.escalate`; audited `report.escalate`, best-effort. `@experimental`, new in 0.2.0. |
| `DELETE /reports/:id/escalate` | "Looked at": clears the ask. The asker or anyone at or above the role asked, else 403 `forbidden`; 200 `{ ok: true }`, also when there was none. Needs `reports.escalate`; audited `report.escalate`, best-effort. `@experimental`, new in 0.2.0. |
| `GET /reports?urgent=1` | The open urgent reports as summaries (`status` must be `open` or left out; another is 400 `invalid_query`, as is any other value of `urgent`), newest first, found at any age. An urgent row carries `urgent: true` (and `handoffAt` once marked); `GET /reports/:id` carries `urgent` and `handoff: { at, by } \| null`. Needs `reports.read`. `@experimental`, new in 0.2.0. |
| `DELETE /reports/:id/hold` | Release the hold. 200 `{ ok: true }`; 404 `not_found` when the report is not held. The owner's, fixed in code. Audited `legal.release`, best-effort. `@experimental`, new in 0.2.0. |
| `GET /reports/:id/bundle?accounts=1` | The report's evidence bundle as one JSON attachment (`no-store`), signed with the kit's `bundleSecret` when it has one (`integrity.hmacSha256` is `null` otherwise). Account ids only with `accounts=1`. 404 `not_found`. The owner's. Audited `legal.bundle` on the report, and the audit is required: no audit, no bundle (500). `GET /reports/:id` also shows `report.hold: { code, at }` while the report is held, never who held it. `@experimental`, new in 0.2.0. |
| `DELETE /policy/profile?section=` | Reset one editable section to the base, or everything when `section` is left out. The body is `{ reason, version? }`: the `reason` is required (1 to 2000 characters), as for `PUT`, and a `version` that is no longer current is 409 `conflict`. Answers `{ ok, changed, effective, base, layer, version, canSave }` like `PUT`. An unknown or empty `section` is 400 `invalid_query`. Needs `policy.write`; audited `policy.reset` with the sections changed and the reason. |
| `GET /audit?cursor&limit&actor&action` | The audit trail, newest first. A `policy.update` or `policy.reset` row also has `detail: { sections, reason? }`, the editable sections changed and the owner's reason. |

Players, under `/api` above. None needs a staff login.

| Route | What it does |
| --- | --- |
| `GET /notices` | Notices not yet acknowledged, oldest first. |
| `POST /notices/:id/ack` | `{ ok }`. `ok: false` (still 200) for a notice that is not the caller's, so ids cannot be probed. |
| `GET /record` | The caller's sanction notices that still apply. |
| `GET /rules` | `{ summary, rules, reporting }`: active rules as `{ number, title, text }`, and `reporting`, what the report screen shows: `{ flow, reasons, thanks }`, with the flow (`one_tap`, `reason_first` or `reason_required`), the *enabled* reasons in order as `{ id, label, hint, group, asksNote }` (never the rule mapping or any staff field) and the thank-you copy. Public, and it follows an edit at once. |
| `GET /code-of-conduct?format=html\|markdown\|text` | The generated document (markdown by default). HTML is sent with a strict `content-security-policy`. |
| `POST /names/check { name }` | Whether a display name is allowed: `{ ok: true }` or `{ ok: false, reason, rule }`, where `reason` is `name_not_allowed` or, with `names.profanity` on (new in 0.1.9), `name_profane`. The caller is passed to the core so a blocked name can be kept as evidence when `names.keepBlocked` is on; it never changes the answer. Limited to 20 a minute per identity (`namesRateLimit`). |
| `GET /appeals` | `{ appeals }` (`@experimental`, new in 0.1.9): the caller's own appeals, newest first, at most 50, each `{ id, noticeId, status, createdAt, decidedAt }` and nothing else (no reason, no staff ref, no sanction or person id). Empty for an unknown or IP-only identity. 404 `not_found` while appeals are off, and then `identify` is not called. |
| `POST /appeals { noticeId, statement }` | File an appeal from one of the caller's own sanction notices (`@experimental`, new in 0.1.9). 200 `{ appeal }`. 400 `invalid_statement` (empty after cleaning, not text, or over 1000 characters). 404 `not_found`: one answer for appeals off, a notice that is not theirs, one that is not an appealable sanction and a malformed id, so notice ids cannot be probed. 409 `already_appealed`. 429 `rate_limited` with `retry-after` in whole seconds, from the weekly cap (`profile.appeals.perPlayerPerWeek`) or from this route's own limiter, `appealsRateLimit`: `{ max, windowMs }`, 10 an hour per identity by default, and a malformed request counts. Every answer is `no-store`. |

**Hidden names (0.1.9).** While `names.maskInHub` is on (the default), a staff body that carries a handle also says when the matcher flags it: `handleFlagged: true` beside a handle
(`GET /appeals`, `GET /sanctions`, `GET /blocked` and the person's history), `targetHandleFlagged` and `reporterHandleFlagged` on a report row and on `GET /reports/:id`, and
`handleFlagged` on each excerpt line of that report. The key is absent when the handle is not flagged, so an unflagged body is exactly what 0.1.8 sent, and with the
setting off no body carries one. The hub uses it to hide the name until a moderator shows it. It is a display flag, not a redaction: the handle is still in the body, and these routes are for staff.

**Reporting from a player.** The kit has no player route for sending a report: it happens inside your game, where you know who is in which seat, so
you call `cw.reports.submit` from your own route (or socket handler). The same goes for the optional follow-up, `cw.reports.addDetail`. Take the
seat from your own session, never from the request body, and the report id from what `submit` answered:

```ts
// POST /report          { targetSeat, lineId?, reason?, note? }  ->  { ok, reportId } or { ok: false, refused }
// POST /report/:id/detail  { reason?, note? }                    ->  { ok } or { ok: false, refused }
// Both seats come from your own session. Send back only what the call answered, plus `reporting.thanks` from `GET /rules` for the thank-you.
const sent = await cw.reports.submit({ roomId, reporterSeat: mySeat, targetSeat, ...(reason === undefined ? {} : { reason }) });
const detail = sent.ok ? await cw.reports.addDetail(sent.reportId, mySeat, { reason: 'cheating', note: 'speed hacking' }) : null;
```

`GET /rules` carries `reporting`, so the report screen can render the flow, the reasons and the thank-you without any other call. Both calls answer
with a plain refusal word (`reason_required`, `reason_unknown`, `too_late`, ...) and never with an identifier.

Other framework? `createRouter(routes)` returns `(req: KitRequest) => Promise<KitResponse>`. Fill `rawBody` with the body
exactly as received and send the response as described on `KitResponse`.

### Appeals and names (0.1.9)

The appeal and rename routes above are part of `adminRoutes` and `playerRoutes`, and are `@experimental` until 0.2, like everything new in the
kit's `appeals` and `names` settings: the routes, `appealRoutes` and `nameRoutes` (the route tables `adminRoutes` is built from), `MeFeatures`, `features` in
`GET /me`, `appeals` in `GET /changes`, `appeals` and `renames` in a person's history, the `handleFlagged` keys, `appealsRateLimit` and `includeAccounts`.
With appeals off every appeal route answers 404 `not_found`, and with all the new settings off every other body is what 0.1.8 sent. A kit
of moderators who are all `moderator` lowers who may decide with `permissions: { 'appeals.decide': 'moderator' }` (the default is `senior`), and a team of one
also sets `appeals.allowSelfReview`, because the kit refuses `same_decider` to the moderator who made the decision: give each moderator their own login.
`POST /appeals` has its own limiter, `playerRoutes(cw, { appealsRateLimit: { max, windowMs } })` (default 10 an hour per identity), in front of the weekly cap.

### The community list (0.1.11)

`adminRoutes(cw, { terms, community: { loader, live, share? } })` adds the staff routes of the shared term list. Nothing is added
unless you pass `community`: without it these routes do not exist (404), `GET /terms` is what it was, and `GET /me` has no
`features.community`. This package imports no matcher code. `community` is described by small structural types
(`CommunityAdmin`, `CommunityLoader`, `CommunityShareClient`, exported as types only); the objects from
`@chatwarden/matcher/corpus` fit them: `loader` is what `startCorpus` returns, `live` is your `LiveTerms`, `share` is what
`createCommunityShare` returns. All of it is `@experimental` until 0.2.

| Route | Permission | What |
| --- | --- | --- |
| `GET /community` | `terms.read` | `{ state, applied, available, pending, lastError: { code, stage } \| null, languages, license, counts, sharing, reporting }`. No term. |
| `POST /community/refresh` | `terms.write` | Check now. The same body as the GET. |
| `POST /community/apply` | `settings` (owner) | Apply the verified list. Audit `community.apply` (target `release:<version>`). The rows are stamped `corpus:<version>`; the staff member is in the audit row only. 409 `nothing_to_apply` or `apply_refused`. |
| `GET /terms/:id` | `terms.read` | One row, a hidden community row too, with `community` and `blocks30d`. |
| `POST /terms/lookup` | `terms.read` | The row for an exact word (folded), or 404. The word is in the body, never the address. |
| `POST /terms/:id/share` | `terms.write` | Send one term of your own to the community list (only with `share`). Body `{ category, target?, note? }`. The answer is `{ status }` only. 409 `not_shareable` for a community row. |
| `GET /terms/:id/share` | `terms.read` | `{ status, reason? }` of the last share of this term, or `{ status: null }` when it was never shared (so a page that asks as it opens an editor logs no 404). |
| `POST /terms/:id/report` | `terms.write` | Report a problem with a term of the community list (only with a `share` that has `report`). Body `{ kind }`, one of `innocent_sense`, `wrong_category`, `removal`. Sends the term id and the kind, never the word. The answer is `{ status: 'received' }`. 409 `not_reportable` for a row of your own. |

`GET /terms` lists your own rows and the community rows a person has touched. The untouched community rows are counted
(`community: { hidden: n }`) and not listed, unless you set `exposeCommunityRows` to `true`. They are reached one at a time with
`GET /terms/:id`. A refused or failed share or report is a fixed error code (`share_unavailable` 502, `share_refused` 422,
`rate_limited` 429, `invalid_request` 400), never the service's text. `GET /me` has `features.community: true` when `community` is wired.

**What is written, and what is not.** Every term route writes only ids. A share or a report writes an audit row for every attempt that reached the service, even when the share fails: the word may have left the server. The row is `term.share` for a share and `term.report` for a report, on the term id, so the audit trail never reads a report as an offer.
The outcome (`offline`, `rate_limited`, `rejected` and so on) is logged as a closed code and nothing else. The core adds four names for the
list (the audit actions `term.share`, `term.report` and `community.apply`, and the target type `release`). A
request that never reached the service (a bad body, an unknown id, too low a role) writes no row.

**Things to know.** The share status is kept in memory in this process (at most 1000 terms, the oldest go first) and is lost
on restart; after a restart a shared term reads as never shared, and sending it again gets `duplicate` or `known` from the service.
Two processes behind a balancer do not share it. Two staff who send the same term at once get `duplicate` for the second. The
service is asked about the status of a term at most once every 15 seconds, however often the page asks, and many reads at the same
moment are one request. The hub never contacts the service.

### The AI routes

Three staff routes serve the AI. They are part of `adminRoutes` and answer as "not set up" until the kit is created with an `ai` adapter; no
route changes a setting (the level moves through `PUT /policy/profile` with `layer.ai`, owner only).

| Route | Permission | What it does |
| --- | --- | --- |
| `GET /ai/status` | `policy.read` | Where the AI stands, and the casebook's counts and rates. |
| `GET /ai/gates` | `policy.read` | `@experimental`, new in 0.1.13. The gate dashboard's data, `cw.ai.gates()`: a cell for each rule and conduct level the profile could act on, each gate's number against its need, the reach and any cooling date. Read-only, computed on the server, no id and no text; `actingAvailable` is false. Audited `policy.view`. |
| `GET /ai/actions` | `ai.review` | `@experimental`, new in 0.1.14. What the AI did or, in shadow, would have done, newest first, `{ items, next }`: each item has the rule, the conduct level, the step, the times and the person's ref (staff only). Query `state` (`shadow`, `active`, `confirmed`, `undone` or `all`), `limit` (1 to 100, default 50) and `cursor` (the previous `next`); a bad one is 400 `invalid_query`. Not audited on read. In this release every row is a shadow row. |
| `GET /ai/acting` | `policy.read` | `@experimental`, new in 0.1.14. Where acting stands, `cw.ai.acting.state()`: `{ mode, paused, modeSince, shadowDaysDone, shadowWouldHaveActed, maxLevel }`, no staff ref. Audited `policy.view`. |
| `POST /ai/acting/shadow`, `/start`, `/resume`, `/off` | the owner (fixed) | `@experimental`, new in 0.1.14. The owner's two audited steps and the way back: `shadow` and `start` take `{ confirm: 'ACT', reason }` (`shadow` from acting needs no word; `start` needs shadow to have run `shadowDays`, 14 by default), `resume` and `off` take `{ reason }`. The role is compared in code, so `permissions` cannot lower them. 200 with the new state, 409 `wrong_state`, `too_early`, `no_appeals`, `ai_level` or `acting_unavailable`, 400 for a wrong word, a missing reason or another key. Each step leaves one `ai.acting` audit row. **Nothing in this release writes a sanction: acting only records what the AI would have done.** |
| `POST /ai/acting/pause` | `ai.pause` | `@experimental`, new in 0.1.14. `{ reason }`: a senior pauses acting; it takes effect before the next act. Same answers as above. Audited `ai.acting`. |
| `PUT /people/:id/automation` | `automation.write` | `@experimental`, new in 0.1.13. `{ allowed, code? }`: `allowed: false` with one of `vulnerable`, `under_review`, `staff`, `sensitive_case` or `other` marks the person "do not automate"; `allowed: true` clears it. No free text. 200 `{ ok: true }`; 400 for a bad body or another key; 404 for a person the kit does not hold or a store that cannot keep the mark. Audited `person.automation` with the person as target. Nothing in this release lets the AI act. |
| `POST /reports/:id/ai/read` | `reports.decide` | "Read again", behind the hub's AI details menu. Audited `ai.rerun` before any call is made. |
| `POST /reports/:id/ai/dont-teach` | `reasons.write` | A senior's mark that a decided report's casebook row can never teach again. |

The errors are `ai_off` (409: the AI is not reading, or the report is decided), `ai_final` (409: the read ended without an answer and was
already retaken once), `ai_budget` (429: the daily money or call limit) and `ai_unavailable` (503, with `retryAfterMs`: the provider is failing
or the minute's calls are used). The full rows are in the table of routes above and the table of errors below.

### Mounting

**Mount `toExpress` before any body parser.** The adapter reads the raw body itself, because a webhook signature must be
checked over the exact bytes and the routes parse JSON with their own 64 KiB limit. If `express.json()` (or `express.raw`,
`express.text`) already ran for a request, the bytes are gone and the answer is 500 `internal` (logged once as
`chatwarden.http_body_already_parsed`). If your app needs `express.json()`, mount it after the kit routes, or on your own
routes only.

**What the adapter answers.** A path that matches none of the kit's routes goes on to the next Express handler: the adapter
calls `next()` before it reads the body, so a kit mounted at `/` does not hide your routes or a later `express.json()`. A path
that matches a route under another method is the kit's 405 (with an `allow` header), and a handler that answers 404 (an unknown
report id) is the kit's 404 `not_found`. Neither falls through, because they are answers.

```ts
app.use('/admin', toExpress(adminRoutes(cw, options)));                      // an unknown /admin/... goes on to your app
app.use('/admin', toExpress(adminRoutes(cw, options), { fallthrough: false })); // an unknown /admin/... is the kit's JSON 404
```

**CORS.** The kit does no CORS handling. If a staff page on another origin calls these routes, mount your CORS middleware
BEFORE `toExpress`: the browser's `OPTIONS` preflight then reaches it first. With `fallthrough` on (the default) an `OPTIONS`
request to a known path, which the kit has no route for, goes on to the next handler like an unknown path does, so a CORS
handler mounted after the kit still answers it. With `fallthrough: false` the kit answers that `OPTIONS` itself with 405, so
the CORS middleware must come first.

```ts
app.use(yourCorsMiddleware);                       // answers OPTIONS preflights, adds the allow-origin headers
app.use('/admin', toExpress(adminRoutes(cw, options)));
```

Use `fallthrough: false` for a prefix that is wholly the kit's, when you want every path under it to get the kit's
`{ error: 'not_found' }` and nothing after it to run. `fallthrough` must be a boolean (`TypeError` otherwise). Put the probes
last anyway: mounted at `/` with `fallthrough: false` they would answer every path, so that mount belongs after your own routes.

### In a browser

`@chatwarden/http/admin` is the staff API without the server parts. It imports no Node builtin, so a browser or edge
bundle can run the routes in the page, over `@chatwarden/store-memory` (a demo, or a hub that talks to the kit directly).
It exports `adminRoutes`, `createRouter`, the errors, `parseJson`, the roles and the permissions, and the `Me` and `MeFeatures` types (the shape of `GET /me`, so a page can name `features`). It leaves out the player
routes, the webhooks and the Express adapter. The router's matcher is exported there as `matchRoute`, as in the root.

```ts
import { createChatwarden, type RawWho } from '@chatwarden/core';
import { createMemoryStore } from '@chatwarden/store-memory';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';

const cw = await createChatwarden({
  store: createMemoryStore(),
  secret: 'demo-secret',
  platform: { identify: (ctx) => ctx as RawWho },
});
const handle = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }) }));

// Pass the exact body text as `rawBody`: the routes read that, never `body`.
const me = await handle({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
```

`GET /me` answers `{ actor, role, can }` for the signed-in caller, so a client can hide what the server would refuse. Every
staff response, success or error, carries `cache-control: no-store`, because the answers differ per caller.

## Auth

The kit never sees a password or a token. You give it two hooks.

### `authorize` (staff)

```ts
authorize: (req: KitRequest) => { actor: string; role: 'moderator' | 'senior' | 'owner' } | null | Promise<...>
```

- Return `null` for nobody: the answer is 401 `unauthorized`. A malformed result also fails closed as 401.
- `actor` is the staff reference the audit trail records: 1 to 128 characters of `A-Z a-z 0-9 _ . : @ + -`, no spaces. Any
  other actor is a 500 `internal` (logged as `chatwarden.http_bad_actor`) rather than a corrupt audit row. An email address works.
- `role` is checked against the permissions table below. Roles rank `moderator` < `senior` < `owner`.
- A hook that throws is a 500. Give each moderator their own actor so the audit trail means something.
- `scope?: string[]` limits the caller to some rooms (staff scope, 1 to 20 labels of `^[a-z0-9][a-z0-9:_.-]{0,63}$`, for example `creator:alice`; a room carries its label in the `scope` tag at `cw.rooms.seat`). A caller with no `scope` sees everything, as before. A scoped caller sees and acts only on the reports filed in those rooms (the filter is in the store query; a report with no scope is invisible to them): an id outside is 404 `not_found`, the same as an unknown id, and the person history holds only their reports and the sanctions that came from them, with no account ids, signals or links. The `owner` role cannot be scoped (a malformed `Authz`: 401). A scoped caller may use only the routes that declare themselves scope-aware: the queue, a case, take next, claim, release, viewing, `GET /changes` (urgent count of their scope), `GET /people/:ref/history`, `GET /sanctions`, `POST /sanctions`, revoke, suggest, decide, `GET /reasons` and `GET /me`. Every other staff route (settings, terms, blocked, names and rename, audit, appeals, the AI, gaps, comments, bulk dismissal, the community routes, and any route a later version adds until it opts in) is 403 `forbidden`. A scoped caller applies a sanction only for a report in their scope (`reportId` in the body of `POST /sanctions`), only a warning or a chat restriction, at most 7 days and never permanent; `adminRoutes(cw, { scopedLimits: { kinds, maxDurationMs } })` widens or narrows that. `GET /me` answers `scope` and a `can` trimmed to what a scoped caller may do. `guard()` and your own routes do not read `scope`: check it yourself if you mount them for scoped callers.

### `identify` (players)

```ts
identify: (req: KitRequest) => RawWho | Promise<RawWho>   // { clientKey?, accountId?, ip? }
```

- Return whatever you know about the caller. The raw `clientKey` is a credential: the kit hashes it and keeps nothing raw.
- A hook that throws, rejects or returns something that is not an object is treated as "nobody": empty lists, `{ ok: false }`
  on ack, and a log line with the error class only.
- `req.remoteAddress` is the socket peer, as the server's own socket reports it. It is never read from a header, so a client
  cannot choose it. Behind a reverse proxy or load balancer it is the proxy's address, and every player would share one IP.
  Whether to trust `X-Forwarded-For` (or your platform's equivalent) is your call: parse it yourself in `identify`, and only
  when the request came from your own proxy. An IP never links two people and never delivers a notice.

## Permissions

The minimum role for each action. These are defaults; override any of them with `permissions` on `adminRoutes` (and `webhookIn`).

| Permission | Default role | Used by |
| --- | --- | --- |
| `reports.read` | moderator | The queue, one report, suggest. |
| `reports.decide` | moderator | `POST /reports/:id/decide`. |
| `reports.decide.bulk` | moderator | `POST /reports/dismiss-open`: dismissing all open reports about one person, or from one reporter, in one confirmed action. The same people may already dismiss each report one by one; raise it to `senior` to keep sweeps for them. The route also needs `reports.decide`. |
| `sanctions.apply` | moderator | `POST /sanctions`, and any decision that carries actions. Also `POST /people/:ref/rename`. |
| `sanctions.apply.ban_permanent` | senior | A ban with `durationMs: null`, on top of `sanctions.apply`. |
| `sanctions.revoke` | moderator | `POST /sanctions/:groupId/revoke`. |
| `history.read` | moderator | `GET /people/:ref/history`, `GET /sanctions`. |
| `blocked.read` | moderator | `GET /blocked`. Raw blocked chat lines, so it is separate from `history.read`. The `term` text in it also needs `terms.read`. Also `GET /blocked?source=name`, the kept blocked names. |
| `gaps.read` | moderator | `GET /gaps`. |
| `gaps.close` | owner | `POST /gaps/:groupId/close`. |
| `terms.read` | moderator | `GET /terms`, `POST /terms/check`, `POST /terms/test`. |
| `terms.write` | moderator | Adding, editing and switching terms and exceptions. |
| `policy.read` | moderator | `GET /policy`, `GET /policy/contexts`, `GET /policy/profile`, `POST /policy/profile/preview`, `GET /ai/status`, `GET /ai/gates`, `GET /ai/acting`. |
| `policy.write` | owner | `PUT /policy/profile`, `DELETE /policy/profile`. Editing the profile changes what every moderator is suggested, so it is the owner's. |
| `audit.read` | senior | `GET /audit`. |
| `claims.override` | senior | Taking over another moderator's claim (`takeOver: true` on a claim, a decision or a direct sanction). |
| `reasons.read` | moderator | `GET /reasons`. |
| `reasons.write` | senior | Adding, editing and switching saved reasons, and `POST /reports/:id/ai/dont-teach`. |
| `settings` | owner | Reserved. No route uses it yet. |
| `appeals.read` | moderator | `GET /appeals`, `GET /appeals/stats`, `GET /appeals/:id` (appeals are off until turned on). |
| `appeals.decide` | senior | `POST /appeals/:id/decide`: uphold, reduce or revoke. A team of moderators lowers it with `permissions`. |
| `ai.review` | moderator | `@experimental`, new in 0.1.13, used from 0.1.14 by `GET /ai/actions`. Confirming or undoing what the AI did arrives with the acting release. |
| `ai.pause` | senior | `@experimental`, new in 0.1.13, used from 0.1.14. `POST /ai/acting/pause`: pausing the AI's acting. The owner's steps (`shadow`, `start`, `resume`, `off`) are not a permission: they are fixed in code. |
| `automation.write` | senior | `@experimental`, new in 0.1.13. `PUT /people/:id/automation`: mark a person "do not automate", or clear the mark. A small team lowers it with `permissions`. |
| `filters.read` | moderator | `@experimental`, new in 0.2.0. `GET /filters/stats`, `POST /filters/test`, `POST /filters/check`: the filters' counts, the test box and the dry run. They read and try, never write. Editing the filters is `policy.write`. |
| `legal.hold` | senior | `@experimental`, new in 0.2.0. `PUT /reports/:id/hold`: hold one report for legal reasons. Releasing a hold, downloading an evidence bundle and finding, exporting and erasing a person's data are the owner's, fixed in code like the AI's acting steps: they are not permissions, so no override can lower them. |
| `reports.urgent` | moderator | `@experimental`, new in 0.2.0. `POST /reports/:id/urgent`: mark a report urgent or not urgent. Urgent is a snapshot kept on the report; the reason's flag sets it at filing. |
| `reports.handoff` | moderator | `@experimental`, new in 0.2.0. `POST /reports/:id/handoff`: mark a case as passed to the game's safety team. A note for colleagues and for the game's own process (it emits `report.handoff`, ids and a time only); it contacts no one. |
| `reports.comment` | moderator | `@experimental`, new in 0.2.0. The staff comment thread on a report (with `desk.workflow` on; otherwise the routes are 404). A moderator removes their own comment, a senior any. |
| `reports.escalate` | moderator | `@experimental`, new in 0.2.0. Ask a senior or the owner for a second look at a report (with `desk.workflow` on). A flag and a thread entry: it does not change the claim or the queue. |
| `insights.read` | moderator | `@experimental`, new in 0.2.0. `GET /insights`: team numbers (with `desk.insights` on; otherwise 404). No per-person figure. |
| `rooms.read` | moderator | `@experimental`, new in 0.2.0. `GET /rooms`: the rooms the process knows and each one's mode. |
| `rooms.manage` | moderator | `@experimental`, new in 0.2.0. Lock a room or start an emergency (it always expires), and take a line back for everyone. A team that wants this to be a senior's sets `permissions: { 'rooms.manage': 'senior' }`. |

```ts
adminRoutes(cw, { authorize, permissions: { 'sanctions.apply.ban_permanent': 'owner', 'audit.read': 'moderator' } });
```

There are no floors: the kit does not stop you from letting a `moderator` ban permanently or read the audit trail. That is
your decision. A bad override (an unknown permission, or a value that is not a role) throws `RangeError` when the routes are built.

## Errors

Every error body is `{ "error": <code>, "message": <fixed text> }`. The message depends only on the code and never repeats
anything the client sent. An unexpected failure is a bare `{ "error": "internal" }` with status 500, and the log line holds the
error class only.

| Code | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | The body or a field is not valid. |
| `invalid_json` | 400 | The body is not JSON. |
| `forbidden_key` | 400 | The body has a `__proto__`, `constructor` or `prototype` key. |
| `invalid_query` | 400 | A query value is not valid (`limit`, `cursor`, `status`, `format`, ...). |
| `invalid_value` | 400 | A number is out of range. |
| `invalid_profile` | 400 | The moderation profile is not valid, or a layer sent to `PUT` / `POST /policy/profile` is not. That body also has `path`. |
| `invalid_filters` | 400 | The `candidate` filter settings of `POST /filters/test` or `/filters/check` are not valid. That body also has `path`, a field of the candidate, never a value. |
| `invalid_sanction` | 400 | The core refused the sanction (a warning with a duration, an uncovered rule with no gap note, ...). |
| `invalid_rules` | 400 | The rules are not valid. |
| `invalid_excerpt` | 400 | The notice excerpt is not valid. |
| `invalid_mode` | 400 | `POST /rooms/:room/mode`: the mode is not `normal`, `locked` or `emergency`. |
| `invalid_term` | 400 | The matcher refused a term change. |
| `invalid_gap_ref` | 400 | Closing a gap as `ruled` needs the number of an active rule. |
| `confirm_mismatch` | 400 | `POST /people/:ref/privacy/erase`: `confirm` is not the person's ref. |
| `invalid_idempotency_key` | 400 | The incoming webhook's key is missing or malformed. |
| `invalid_statement` | 400 | An appeal statement is empty after cleaning, not text, or over 1000 characters (appeals are off until turned on). |
| `duration_not_offered` | 400 | The profile has `customDuration` off and the length is not one it offers. |
| `unauthorized` | 401 | `authorize` returned nobody, or a webhook signature did not verify. |
| `forbidden` | 403 | The caller's role is below the permission's. |
| `not_found` | 404 | No such id, path, or the group was already revoked. |
| `method_not_allowed` | 405 | The path exists under other methods; the `allow` header lists them. |
| `already_decided` | 409 | The report (or the appeal) was decided already, differently. |
| `already_held` | 409 | `PUT /reports/:id/hold`: the report is already held. |
| `comment_limit` | 409 | `POST /reports/:id/comments`: the report's staff thread already holds 50 entries. |
| `already_appealed` | 409 | This sanction has had its appeal (one per sanction). |
| `same_decider` | 409 | The moderator who made the decision cannot decide its appeal (`appeals.allowSelfReview` lifts this for a team of one). |
| `gone` | 409 | The sanction an appeal was about is gone (revoked meanwhile); the appeal is closed as moot. |
| `not_shareable` | 409 | `POST /terms/:id/share` for a row the shared list added (it is already on it). |
| `not_reportable` | 409 | `POST /terms/:id/report` for a row of your own (only a term of the community list can be reported). |
| `nothing_to_apply` | 409 | `POST /community/apply` with no verified community list. |
| `apply_refused` | 409 | `POST /community/apply` was refused by the live term list (it would leave no active term, or unblock a known line); nothing changed. |
| `pending_rename` | 409 | `POST /people/:ref/rename` while an earlier request is still waiting for the game to release the player. |
| `conflict` | 409 | The profile settings changed since the caller loaded them (`PUT` or `DELETE /policy/profile` with an old `version`). |
| `claimed` | 409 | Another moderator holds the case. The body also has `by` (who) and `until` (when the claim lapses, epoch ms). |
| `ai_off` | 409 | `POST /reports/:id/ai/read` while the AI is not reading (level 0, no adapter, or the report is decided). |
| `ai_final` | 409 | `POST /reports/:id/ai/read` on a read that ended without an answer and was already retaken once. |
| `acting_unavailable` | 409 | An acting step with no AI, a `maxLevel` below 3, `ai.act.enabled: false` or a store that cannot keep the state. |
| `no_appeals` | 409 | An acting step that raises what the AI does, while in-kit appeals are not enabled. |
| `ai_level` | 409 | An acting step while the hub's AI level is below 2 (recommend). |
| `too_early` | 409 | `POST /ai/acting/start` before shadow has run its days. |
| `wrong_state` | 409 | An acting step the state does not start from (or another process moved it first). |
| `in_progress` | 409 | An incoming-webhook request with this idempotency key is still running. Retry later. |
| `idempotency_mismatch` | 409 | The idempotency key was used with a different request. |
| `payload_too_large` | 413 | The body is over 64 KiB. |
| `share_refused` | 422 | The community service did not take the term (rejected, or a language it does not support). No service text is passed on. |
| `rate_limited` | 429 | Too many name checks, or too many read-again requests; `retry-after` says how long. |
| `ai_budget` | 429 | The AI has reached its daily limit; reads resume at 00:00 UTC. |
| `not_supported` | 501 | The store cannot do this: it cannot save profile settings (no `savePolicyLayer`), or it lacks the urgent-lane methods that `POST /reports/:id/urgent` and `POST /reports/:id/handoff` use (`setReportUrgent`, `setHandoff`; the kit warns once at start, naming what is missing). |
| `share_unavailable` | 502 | The community service could not be reached, or the share object failed. |
| `ai_unavailable` | 503 | `POST /reports/:id/ai/read` while no call can be made (the breaker is open, or the minute's calls are used). The body also has `retryAfterMs`; `retry-after` says the same in seconds. |
| `internal` | 500 | Anything else. No detail is sent. |

## Chat

`@chatwarden/http/chat` (also exported from the root) is a room broadcaster and five routes: a game with no chat adds moderated chat in
minutes. Every line goes through `cw.chat.accept` and nothing else decides delivery; a refusal is shown to its author only; a bounded
in-memory history lets a late joiner see the room. The browser side is `<ChatBox>` in `@chatwarden/player-react/chat`. The subpath
imports no `node:` module, so it can also run in a browser tab (a demo). All its names are `@experimental` until 0.2.

```ts
import express from 'express';
import { chatRoutes, createRoomBroadcaster, type KitRequest } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import type { RawWho } from '@chatwarden/core';

declare function sessionOf(req: KitRequest): { accountId: string; displayName: string; rooms: string[] } | null;

const chat = createRoomBroadcaster(cw); // one per process
const app = express();
app.use(
  '/chat',
  toExpress(
    chatRoutes(cw, chat, {
      // The same identify as playerRoutes: who is asking, from your session. An address alone is never a chat identity (401).
      identify: (req: KitRequest): RawWho => {
        const s = sessionOf(req);
        return s === null ? {} : { accountId: s.accountId };
      },
      // May this player enter this room, and under what name? null is 403. Required: the kit does not guess who may be where.
      join: (req, roomId) => {
        const s = sessionOf(req);
        return s !== null && s.rooms.includes(roomId) ? { name: s.displayName } : null;
      },
    }),
    { fallthrough: false },
  ),
);

// A notice landed for someone: tell their open chat boxes (nothing about it is sent). Call it from your `platform.notify`.
// chat.noticePending(subject);
// On shutdown: chat.close() ends every stream with a `bye`.
```

### The five routes

All paths are relative to the mount point. `:room` is a kit route param (1 to 64 of `A-Z a-z 0-9 _ -`). Every response carries
`cache-control: no-store`; the stream's is `no-store, no-transform`, which is what keeps a body-rewriting middleware (`compression`) and a
proxy from holding its first frames back. Errors use the kit's shapes.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /rooms/:room/stream` | none | `200 text/event-stream`: a `hello` first, then `line`, `hide`, `state`, `notices`, `mode`, `retract` and `bye` frames, and a `: ping` comment every `heartbeatMs` |
| `POST /rooms/:room/lines` | `{ text }` | `200 { ok: true, line }` or `200 { ok: false, refused: { reason, until?, byModerator?, rule?, noticeId?, retryAfterMs? } }` (a refusal is an answer). With the chat filters on (0.2.0, `profile.filters`) `reason` can also be `link`, `personal_info` or `filter`, with the `rule` the owner chose and never what matched; a masked line is delivered starred and the author's `line` shows the starred text |
| `POST /rooms/:room/mute` | `{ lineId, on, block? }` or `{ ref, on, block? }` | `200 { ok, hiddenIds, limit? }`: the ids of the muted player's lines the server hid from the muter. `block: true` (a boolean, else 400) with `on` makes it a block: a mute that is also two-way and never expires. The blocked player's streams get a `hide` frame of the blocker's lines already in the room and later lines are filtered both ways; the blocker's `muted` entry carries `block: true`; the blocked player is told nothing. `limit: true` (with `ok: false`) says the list holds 500 blocks. Unmute (`on: false`) undoes either. |
| `POST /rooms/:room/phrases` | `{ phrase }` | For a phrase-only room (its context sets `chat.phrases`): `phrase` is the id of one phrase of the room's book, which `hello.phrases` (`{ book: [{ id, text, group? }] }`, `null` for a free-text room) carries. `200 { ok: true, line }` with `line.phrase` set and `line.text` the canonical text, or `200 { ok: false, refused }` (`gate` for a room that is not phrase-only, `phrase_unknown` for an id the book lacks). Typed text in a phrase room is refused `phrases_only` on `lines`. Same guards, limits and 400/401/403/429 as `lines` |
| `POST /rooms/:room/report` | `{ lineId, reason?, note? }` | `200 { ok: true, remaining }` or `200 { ok: false, refused }`; nothing else, never a report id |

Bodies must be `application/json` (anything else is 400, so a cross-site form cannot make a player speak). A banned player's stream is
one `bye` frame. A refused line is never echoed to anyone but its author, never kept in the history and never logged. A mute is silent:
the muted player is never told. Nothing identifies a player on the wire: a line is `{ id, at, name, text, mine? }`, with no seat, subject,
key, hash or address. `hello` carries `epoch`, `room`, `you`, `maxLength`, `heartbeatMs`, `now` (the server clock, ms), `summary`,
`restriction`, `lines` (the viewer's snapshot, at most 50, never older than 15 minutes) and `muted`.

**Wire version 2** (`@experimental`, new in 0.2.0; `CHAT_WIRE_VERSION` is 2, and a client reads only the version it was built for). `hello` also carries `mode: { kind, until }` (the room's mode: `normal`, `locked` or `emergency`, and when it ends) and `you.readOnly` (`locked` or `new_account`, only when the viewer cannot post because of the room's mode). A `mode` frame `{ mode, readOnly? }` goes to every open stream when the mode changes and when it ends (the broadcaster's own timer at `until`; the kit decides every line against its own clock, so a late timer never makes an answer wrong), with `readOnly` worked out for each viewer. A `retract` frame `{ ids }` goes to every stream, the author's too, when a moderator takes lines back (`cw.rooms.retract`): the broadcaster drops them from its history, so a joiner never sees them, and the box replaces each with "Message removed by a moderator". The broadcaster listens to the kit's `room.mode` and `line.retracted` events (a game with its own socket listens to the same ones) and stops when it closes. A refusal can now also be `locked` or `new_account` (with `until`) or `probation` (with `retryAfterMs`). `ChatMember.staff` (`true` only) and `ChatMember.evidenceRef` come from your `join` hook and nowhere else: a staff member may talk in a locked room and is never made read-only, and a report filed from the chat box carries the evidence id; no request field sets either.

### Chat options

| `createRoomBroadcaster(cw, options)` | What it does |
| --- | --- |
| `history` | `{ lines, maxAgeMs }` kept per room for late joiners: at most 100 lines (default 50) and never older than the evidence window (default 15 min) |
| `maxMembers`, `maxRooms`, `maxStreams` | Limits (500 players per room, 10 000 rooms, 5 000 streams); over one, a `429` with `retry-after` |
| `maxStreamsPerMember` | Streams (tabs) one player may have open in a room, default 3. A fourth is not refused: the player's OLDEST stream is sent `bye` with reason `replaced` and ended, so a connection that died without a word (a phone changing network) cannot lock them out. The box treats `replaced` as closed and offers "Try again" instead of reconnecting by itself, so tabs beyond the limit do not push each other out in a loop |
| `heartbeatMs` | How often an idle stream gets a `: ping` (default 20 000, at most 60 000). The `hello` announces it, and the box drops a stream silent for 2.5 times that |
| `seatGraceMs` | How long a seat with no stream and no request is kept (default 120 000) |
| `maxBacklog` | A stream whose sink refused this many writes in a row is closed (default 64) |
| `seatSalt` | Keys the seat ids (default random per broadcaster). Seat ids never leave the server |
| `nameCheck` | Check each display name with `cw.names.check` (default true); a refused or blank name becomes `Player N` |
| `now`, `schedule`, `logger` | The clock, the timer and where failures are logged (event name and error class only) |

| `chatRoutes(cw, chat, options)` | What it does |
| --- | --- |
| `identify`, `join` | Required, above |
| `actionRateLimit`, `openRateLimit` | Lines, mutes and reports per player (default 30 per 10 s), and stream opens per player (default 10 per minute) |
| `allowedOrigins` | When given, a request with an `Origin` not in the list is 403. A request with no `Origin` is allowed |
| `logger`, `now` | As above |

### Behind a proxy

- Do not put `compression` middleware over `text/event-stream`: it buffers the stream. The adapter sends `x-accel-buffering: no` for nginx.
- A proxy's idle timeout must be longer than the heartbeat (20 s by default).
- `identify` runs on every request, the stream included, and must read the real client address from your proxy's header (the same note as
  for the player routes).
- **`identify` must authenticate a real login** (a session token, a signed cookie). The per-player limits (`actionRateLimit`,
  `openRateLimit`) and the mutes are keyed by the identity `identify` returns, so a caller who can invent identities escapes them, and with a
  permissive `join` each invented identity also takes a seat in the kit for `seatGraceMs`. Use header auth, or a `SameSite=Strict` cookie.
  A cross-site `no-cors` GET carries no `Origin` header, so `allowedOrigins` does not see it: its response is unreadable to the other site, but
  it can seat the victim and spend their `openRateLimit`. Validate the room id in `join` (a room id in a URL must not create a room).
- **Line length.** The box shows a line of up to 1 000 characters and clips any longer one, so `createRoomBroadcaster` throws a `RangeError`
  for a kit configured with `limits.chatMaxLength` above 1 000. The route answers `length` without asking the kit for any text over 2 000.

### One process per room

Everything the chat path reads is per process: the roster, the evidence buffer, the rate limiter and the history ring. In this release the
supported arrangement is sticky rooms: route all of a room's connections to one process (as pacing already advises). Two processes serving
one room would each have their own history and their own idea of who is in it. A pub/sub hook between processes is not shipped.

### A game's own socket

The broadcaster does not know about HTTP: it writes frames to a `ChatSink` (`write`, and optionally `ping` and `end`). `chatRoutes` is one
adapter; a game with Socket.IO or Colyseus calls the broadcaster from its own handlers, and implements `ChatTransport` on the client.

```ts
// Socket.IO, sketch: everything between the socket and the kit is the broadcaster's job.
io.on('connection', (socket) => {
  const session = chat.session('lobby', yourWho(socket), { name: yourName(socket) });
  if ('refused' in session) return socket.emit('chat:refused', session.refused);
  const stream = session.open({ write: (frame) => socket.emit('chat:frame', frame) });
  if ('refused' in stream) return socket.emit('chat:refused', stream.refused);
  socket.on('chat:send', (text, ack) => ack(session.send({ text })));
  socket.on('chat:mute', (input, ack) => ack(session.muteResult(input)));
  socket.on('chat:report', async (input, ack) => ack(await session.report(input)));
  socket.on('disconnect', () => stream.close());
});
```

### Things to know

- **`name` is a display name, not an identifier.** The kit checks it with `cw.names.check` and cuts it at 32 characters, but a game whose
  `join` returns an account id as the name has leaked it itself.
- **`byModerator` on a restriction.** The refusal from `accept` says exactly who set a restriction. The restriction in `hello` and `state`
  is read from the stored sanction, and a stored automatic chat timeout reads as a moderator's there, so the box words it as a moderator's
  until the player's next refused line. A core change (`byModerator` on the answer of `cw.chat.restricted`) would make it exact.
- **Needs a newer core.** The broadcaster re-reads a player's restriction with `cw.chat.restrictedBySubject`, which is new in core 0.1.6
  (`cw.chat.restrictedBySubject` is new with the chat box; `createRoomBroadcaster` throws a `TypeError` with a core that lacks it). Since 0.1.7 the queue and the case page also call `cw.ai`
  (the AI's brief and read), which core 0.1.6 does not have, and since 0.1.8 they also call `cw.signals` (`boosted`, `forRecord`) and read `limits` from `cw.policy.get()`, which core 0.1.7 does not have. Since 0.1.9 the routes also call `cw.appeals`, `cw.names.flagged`, `cw.names.requireRename`, `cw.names.renamesEnabled`, `cw.names.renamesOf`, `cw.blocked.names`, `cw.people.accountIds` and the three new event types, which core 0.1.8 does not have. Install `@chatwarden/http` and `@chatwarden/core` from the same release. The package's
  peer range on core is `^0.1.9`.
- **Experimental names** (listed so until 0.2): `createRoomBroadcaster`, `chatRoutes`, `encodeFrame`, `HEARTBEAT`, `CHAT_WIRE_VERSION`,
  `refusalOf`, `ROOM_BROADCASTER_DEFAULTS`, and the types `ChatMember`, `ChatSession`, `ChatSink`, `ChatStream`, `RoomBroadcaster`,
  `RoomBroadcasterOptions`, `ChatRoutesOptions`, `ChatFrame`, `WireLine`, `WireRestriction`, `WireMuted`, `WireRefusal`, `SendResult`,
  `MuteTarget`, `MuteResult`, `ReportOutcome`, and, new in 0.2.0, `WireMode`, `WirePhrase`, `WirePhrases` and `WireReadOnly`.

## Webhooks

### Outgoing: `webhooksOut`

```ts
import { webhooksOut } from '@chatwarden/http';

const out = webhooksOut(cw, {
  endpoints: [
    { url: 'https://staff.example.com/chatwarden', secret: process.env.WEBHOOK_OUT_SECRET!, events: ['report.created', 'sanction.applied'] },
    // Chat text only if you really want it, to a receiver you control:
    // { url: '...', secret: '...', events: ['report.created'], includeExcerpts: true },
    // Your game's own server, to learn which player to rename (the account ids you passed as RawWho.accountId):
    // { url: '...', secret: '...', events: ['rename.required'], includeAccounts: true },
  ],
});
// on shutdown: out.dispose()
```

`events` is `'*'` or a list from `report.created`, `report.closed`, `sanction.applied`, `sanction.revoked`, `gap.created`,
`auto.restricted` and, new in 0.1.9 (`@experimental`), `appeal.created`, `appeal.decided` and `rename.required`, and, new in 0.2.0 (`@experimental`), `insights.digest` (the Insights numbers, counts and times only, raised when you call `cw.insights.emitDigest()`; the kit has no scheduler, so call it from your own timer). The URL must be `https:` (plain `http:` only for `localhost` and `127.0.0.1`) with no credentials in it. The
secret is at least 32 characters. A bad value throws `RangeError` when you call `webhooksOut`, and nothing is subscribed.

Each delivery is a `POST` with a JSON body `{ id, type, at, data }`: `id` is a UUID for the delivery, `type` the event type, `at`
the time it was raised (epoch ms) and `data` the event itself (ids, codes, rule numbers and times; no chat text, reasons or notes).

Headers:

| Header | Value |
| --- | --- |
| `x-chatwarden-timestamp` | Unix seconds when this attempt was signed. |
| `x-chatwarden-signature` | `v1=` plus the lowercase hex HMAC-SHA256 of `${timestamp}.${body}` under the endpoint's secret. |
| `x-chatwarden-delivery` | The delivery id (the same as `id` in the body, and the same on every retry). |

**Signing recipe.** `signature = "v1=" + hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`, where `timestamp` is the header's
text and `rawBody` the exact request bytes (as UTF-8 text). Every attempt, a retry included, is signed afresh with a new timestamp.

**Verifying** (Node, with this package's own `verify`):

```ts
import express from 'express';
import { ReplayCache, verify } from '@chatwarden/http';

const seen = new ReplayCache(); // one per secret; remembers accepted signatures
const handled = new Set<string>(); // delivery ids already handled (use your database in production)
const app = express();

app.post('/chatwarden', express.raw({ type: 'application/json' }), (req, res) => {
  const body = (req.body as Buffer).toString('utf8'); // the exact bytes, before any JSON parsing
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
  if (!verify(process.env.WEBHOOK_OUT_SECRET!, headers, body, Date.now(), seen)) return void res.sendStatus(401);
  const delivery = JSON.parse(body) as { id: string; type: string; data: Record<string, unknown> };
  // A retry carries the same delivery id with a fresh signature: handle each id once, answer 2xx to a repeat.
  const id = String(req.headers['x-chatwarden-delivery'] ?? delivery.id);
  if (handled.has(id)) return void res.sendStatus(200);
  handled.add(id);
  // Handle it, then answer 2xx quickly.
  res.sendStatus(200);
});
```

`verify` returns true only when the timestamp is within 5 minutes of your clock either way, the signature has the `v1=` form,
the HMAC matches (compared in constant time) and the same signature has not been accepted before. In any other language,
compute the same HMAC yourself, compare in constant time, reject a timestamp more than 5 minutes old or new, and remember the
signatures you accepted for 5 minutes.

**Deduplicate on the delivery id.** Delivery is at-least-once: a delivery that got no 2xx is sent again with the same id (and
a new signature), so a receiver that already handled that id should answer 2xx and do nothing.

**Retries.** A 2xx is success. A network error, a 10 second timeout, a 5xx or a 429 is retried 5 times (6 attempts in all)
after 1, 2, 4, 8 and 16 seconds, each with plus or minus 20 percent jitter; a 429's `retry-after` replaces
the wait, held between `RETRY_AFTER_FLOOR_MS` (1 second) and `RETRY_AFTER_CAP_MS` (60 seconds); both are exported. Any other status (a 4xx, or a redirect: none is followed) is final. A delivery that fails for good is logged
(`chatwarden.webhook_failed`: event type, status or error class, attempt count) and dropped. The queue is in memory, one per
endpoint, delivered in order, one at a time, and holds 1000: past that the oldest waiting delivery is dropped and logged as a
count (`chatwarden.webhook_dropped`). A restart loses what is queued. Do not rely on webhooks as the only copy of a fact; the
staff API has it too.

**Events carry subject ids.** `sanction.applied`, `sanction.revoked`, `gap.created` and `auto.restricted` name the person by
subject id. A subject id is an identifier, so send events to staff endpoints only, never to a player or a public channel.
Chat text is never in an event. `includeExcerpts: true` adds the report's excerpt (the lines players typed, blocked ones
included, with their seat and handle) to `report.created` and nothing else. That is private conversation: turn it on only for a
receiver you control and may show chat text to. `appeal.created`, `appeal.decided` and `rename.required` carry ids, codes and times and never a
statement, a reason or a handle. `rename.required` names the person by staff ref, which means nothing to your game: `includeAccounts: true` adds
`accounts: string[]` to it (and to no other event), the account ids you passed as `RawWho.accountId`, fetched when the event is raised. An account id
is your own identifier for a player, so turn it on only for a receiver your game controls.

### Incoming: `webhookIn`

One route, `POST /webhooks/in/action` (mounted at `/hooks` above, so `/hooks/webhooks/in/action`). Sign the request the way
`webhooksOut` does, with the secret you gave `webhookIn`, and send JSON:

```jsonc
// Decide a report, exactly as POST /reports/:id/decide:
{ "action": "decide", "input": { "reportId": "...", "verdict": "upheld", "reason": "...", "actions": [ { "subject": "s_...", "kind": "chat", "durationMs": 3600000, "rule": 1 } ] } }

// Apply one sanction, exactly as POST /sanctions. idempotencyKey is required:
{ "action": "sanction", "input": { "subject": "s_...", "kind": "warning", "durationMs": null, "rule": 2, "reason": "...", "idempotencyKey": "ticket-4411" } }
```

- Any signature failure (missing or malformed header, a timestamp more than 5 minutes off, a wrong signature, a replay) is the
  same 401 `unauthorized`. A signature is accepted once, so sign every attempt afresh, including a retry.
- The actor is always the `actor` you configured and the source always `moderator`. An `actor`, `source` or `role` in the body is ignored.
- The route acts with `role` (default `moderator`) and the same permission table as the staff routes. At `moderator` it can
  decide and sanction but cannot ban permanently unless you change `sanctions.apply.ban_permanent`.
- **Idempotency keys.** A sanction needs `idempotencyKey` (1 to 64 characters of `A-Z a-z 0-9 _ . : -`). The same key within 24
  hours returns the first result (`{ groupId, refCode }`) and applies nothing more. The same key with a different sanction is
  409 `idempotency_mismatch` and nothing is applied. A key whose first request is still running is 409 `in_progress`: retry
  later. A sanction that failed (400 or 500) frees its key. A decision needs no key: the core makes decisions idempotent.
- **Rate-limit this route at the edge.** A failed signature costs one body read (64 KiB at most) and one HMAC, and the kit does
  not throttle them. Put a limit in front of it (your reverse proxy, load balancer, or `express-rate-limit` on the mount) so a
  flood of bad requests is stopped before it reaches the process.

## Discord bot

`@experimental` until 0.2. A bot that lives in your Discord server and answers staff. It does two things:

- `/chatwarden lookup <code>` tells a moderator what a reference code (like `M-7K3Q9`) stands for, so they can answer a player who quotes one.
- Optional: two buttons on each report post, "Nothing wrong here" and "Apply suggestion", with a confirm step. A click decides the report
  through the same checks as the hub.

It is in its own entry, `@chatwarden/http/discord`, and not in the package root, because it uses `node:crypto`. It does nothing when you
import it. Pair it with the feed in `@chatwarden/discord`, which posts the report and shows the buttons. The bot never reads Discord's
gateway, never holds a bot token and never posts chat text, a handle, a reason or a note.

### Set up, in order

1. **Make the application.** In the Discord Developer Portal, create an application. Copy the **application id** and the **public key**
   (64 hex characters; it is not a secret).
2. **Make the bot and invite it.** Add a bot to the application. Invite it to your moderation server with the scopes `bot` and
   `applications.commands`, with **Manage Webhooks** on the forum channel. Copy the **bot token** and keep it off the server: only
   `registerCommands` uses it, once.
3. **Make the application-owned webhook.** A webhook made by hand cannot send buttons you can click, so make it with the bot. One request:

   ```sh
   curl -X POST "https://discord.com/api/v10/channels/$FORUM_CHANNEL_ID/webhooks" \
     -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"Chatwarden"}'
   ```

   The answer holds an `id` and a `token`. The feed's URL is `https://discord.com/api/webhooks/<id>/<token>`. The name may not contain
   "clyde" or "discord". The URL is a credential: keep it in a secret store.
4. **Copy the role ids.** Turn on Developer Mode, right-click each role and choose **Copy Role ID**. You need the ones for your moderators,
   seniors and owners. Also copy the server's id.
5. **Add it to your server** (the block below). The route is `POST /discord/interactions`. Mount it where nothing reads the body first: the
   signature covers the exact bytes (`toExpress` and `toFetch` keep them as `rawBody`).
6. **Deploy, then paste the route's full URL** into the application's **Interactions Endpoint URL** in the Developer Portal. Discord sends a
   PING when you save; the bot answers it, and the Portal refuses the URL if it does not.
7. **Register the command, once** (the second block). The command list replaces the application's commands in that server.
8. **Try it.** Run `/chatwarden lookup` with a code from a sanction you applied. File a test report and click a button.

```ts
import express from 'express';
import { discordFeed } from '@chatwarden/discord';
import { toExpress } from '@chatwarden/http/express';
import { discordBot } from '@chatwarden/http/discord';

const hubLink = (kind: 'report' | 'person', id: string) => `https://mod.example.com/${kind === 'report' ? 'reports' : 'people'}/${encodeURIComponent(id)}`;

const bot = discordBot(cw, {
  applicationId: process.env.DISCORD_APP_ID!,
  publicKey: process.env.DISCORD_PUBLIC_KEY!, // 64 hex characters, from the Developer Portal
  guildId: process.env.DISCORD_GUILD_ID!, // the one server this kit serves; every other is refused
  roles: {
    moderator: [process.env.DISCORD_ROLE_MODERATOR!],
    senior: [process.env.DISCORD_ROLE_SENIOR!],
    owner: [process.env.DISCORD_ROLE_OWNER!],
  },
  hubLink,
  actions: { dismiss: true, suggestion: true }, // leave this out and the bot only answers /chatwarden lookup
});

const app = express();
app.use('/', toExpress(bot.routes)); // POST /discord/interactions, with no body parser before it

const feed = discordFeed(cw, {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL!, // the application-owned webhook from step 3
  hubLink,
  components: bot.components, // the buttons on a report post
});

// on shutdown
feed.dispose();
bot.dispose();
```

Register the command once, from your own machine (the bot token never goes on the server). `bot` is the one above:

```ts
import { registerCommands } from '@chatwarden/http/discord';

const result = await registerCommands({
  applicationId: process.env.DISCORD_APP_ID!,
  botToken: process.env.DISCORD_BOT_TOKEN!,
  guildId: process.env.DISCORD_GUILD_ID!,
  commands: bot.commands(),
});
console.log(result.ok ? `registered ${result.count} command(s)` : `Discord answered ${result.status}`);
```

`registerCommands` answers `{ ok: true, count }` or `{ ok: false, status }` (status `0` when there was no answer). A bad id or token is a
`RangeError` that never repeats the value. A 429 is waited out once. The token is sent in one header and is in no result, error or log.

### What the bot says

Every answer is ephemeral (only the person who clicked sees it) and mentions no one. The words are fixed.

| When | The answer |
| --- | --- |
| A lookup finds the code | The code, the kind, the length, the Community Rule, whether it is active, ended or lifted, when it was given, and who gave it in words (a moderator, the chat filter, Coop, the AI read, the API). An "Open person" link. No reason, no moderator, no handle, no subject id. |
| A lookup finds nothing, or the code is malformed | `No sanction found for that code.` (the same text for both) |
| A click on "Nothing wrong here" or "Apply suggestion" | A preview of what it would do, with Confirm and Cancel. For the suggestion: the step, the rule and the one-line why. |
| Confirm | `Done`, the step and the code. The report closes, the feed posts the outcome and takes the buttons off. |
| The same confirm again | `Already done`, and nothing is applied twice. |
| The report was decided in the hub first | `This report was already decided (...)` with an "Open report" link. |
| The profile's suggestion changed since the preview | `That changed. Open it in the hub.` |
| The report needs a Community Rule chosen | `This report needs a Community Rule chosen. Open it in the hub.` |
| Another moderator has the case open | `Another moderator has this case open.` A Discord click never takes a case over. |
| No role, no permission, too many clicks, the wrong server | A fixed refusal. Role names and ids are never echoed. |
| Anything goes wrong | `Something went wrong. Try again in the hub.` The class of the error is logged, never its text. |

With `actions: { confirm: false }` the first click decides at once, with the same checks. The answer is still a private message; the report post
itself changes only when the report closes.

### Who may do what

You map Discord role ids to the kit's three roles with `roles`. A person's kit role is the highest one they hold an id of. A role you did
not list is nothing. The permission for each step is the staff routes' table (see Permissions), and `permissions` overrides it the same way:

- lookup needs `history.read`, and is audited as `history.view`;
- a preview needs `reports.read`, and a suggestion preview is audited as `suggest`;
- a confirm needs `reports.decide`, and `sanctions.apply` for a sanction, and `sanctions.apply.ban_permanent` (senior by default) for a permanent ban. The decision is audited as `report.decide`.

Nothing in a Discord payload except the signed `member.roles` and `user.id` picks the role, the actor or the source. The actor is
`discord:<user id>`, or what your `actorOf` gives for that user (so a moderator's own claim does not block them). The source is `moderator`.

### Discord bot options

| Option | What it does |
| --- | --- |
| `applicationId` | The application id (17 to 20 digits). Required. |
| `publicKey` | The application's Ed25519 public key, 64 hex characters. Required. |
| `guildId` | The one server this kit serves. An interaction from any other, or a DM, is refused. Required. |
| `roles` | Discord role ids per kit role (`moderator`, `senior`, `owner`). At least one id overall. Required. |
| `hubLink` | `(kind, id) => url`. Where "Open report" and "Open person" go. A throw or a URL that is not `http(s)` drops that link. Required. |
| `actions` | `{ dismiss?, suggestion?, confirm? }`. Leave it out for lookup only. `dismiss` and `suggestion` default `true` once it is set; `confirm` defaults `true`. |
| `permissions` | Overrides of the minimum roles, checked as for the staff routes. |
| `actorOf` | `(discordUserId) => string \| undefined`. Map a Discord user to a hub login. An invalid answer or a throw falls back to `discord:<id>`. |
| `rateLimit` | Per Discord user, `{ max, windowMs }`. Default 20 a minute. |
| `timestampToleranceMs` | How far a signed timestamp may be from the clock, either way. Default 300 000 (5 minutes). |
| `respondWithinMs` | How long work may take before the bot answers "working on it". Default 2 500; under Discord's 3 000. |
| `fetch` | The `fetch` for the one follow-up of a slow answer. Default the global one. For tests. |
| `schedule` | `(run, ms) => cancel`. The timer behind `respondWithinMs` and the one retry. Default `setTimeout`. For tests. |
| `replay` | The replay memory (a `ReplayCache`). Default a new one. |
| `clock`, `logger` | Time source, and where failures are logged (an event name and an error class only). |

`bot.routes` is the route table. `bot.components` goes to `discordFeed`. `bot.commands()` goes to `registerCommands`. `bot.dispose()` forgets what the
bot holds and cancels its timers; a disposed bot answers 401. The names `discordBot`, `DiscordBotOptions`, `DiscordBot`, `DiscordCommand`,
`DiscordActionRow`, `DiscordButton`, `DiscordCommandOption`, `registerCommands`, `RegisterCommandsOptions`, `RegisterCommandsResult` and `verifyInteraction` are `@experimental` until 0.2.

### Slow work

Discord wants a first answer within 3 seconds. If the work is not done in `respondWithinMs`, the bot answers at once with a loading message
(type 5, only the clicker sees it; or type 6 for a click on the private Confirm), and when the work finishes it edits that answer once
(`PATCH https://discord.com/api/v10/webhooks/<application id>/<token>/messages/@original`, no Authorization header: the token is the key). A
429 is waited out once, for the time Discord names, between 1 and 60 seconds. Any other failure is logged by class and dropped. The interaction
token is never logged and never stored. Work that throws gives the fixed failure text.

### Discord bot: security notes

- **Verify before parse.** The route checks the signature over the exact bytes before it reads the body. A missing or malformed header, a wrong
  key, a stale or future timestamp, a changed byte and a replayed request are all the same `401 { "error": "unauthorized" }`. A body over 64 KiB is a 413 before any check.
- **The bot never trusts a `custom_id`.** It is a short, closed format. Every click re-reads the report, the claim, the rule and the profile; a
  code that is not the current suggestion is refused.
- **No secret leaves.** No log line, answer or error holds a token, a signature, a subject id outside a hub link, chat text or a handle.
- **Rate-limit the route at your edge.** The bot limits each Discord user after the signature check, but an unsigned request still costs a body
  read and a signature check. A low per-address limit in front of `/discord/interactions` is fine: Discord sends few requests. Do not block
  Discord's addresses.
- **Keep the webhook URL and the bot token secret.** The bot token is only for `registerCommands`.
- **One restart caveat.** The feed forgets which post held which buttons when the process restarts. An old post keeps its buttons, and a click
  on one is answered from the report ("already decided").
- **Two things Discord's docs leave open,** checked by hand before you rely on them (see `docs/plans/follow-ups.md`): that a webhook made with
  the bot is application-owned, and that the command's default visibility value is right. If the first is wrong the feed logs
  `chatwarden.discord_components_ignored` and posts without buttons.
- **One more thing to check by hand:** that a slow click on the public report post shows only the clicker a loading message and leaves the post as it was (the bot answers
  type 5 with flags 64 there, and type 6 only on the private Confirm and Cancel). Step 5 of the live check in `docs/plans/follow-ups.md` says how.

## Coop

`@experimental` until 0.2. [Coop](https://github.com/roostorg/coop) is an open-source review tool. This adapter sends each report to Coop as a job, so reviewers
can work there. When a reviewer decides, Coop calls your server, and the kit applies the decision through the same checks as the hub.

The kit stays the source of truth. Coop is a place to review. Only the kit writes sanctions, notices and the status of a report. A job in Coop does not
change the report: it stays open in the hub until someone decides it.

It is in its own entry, `@chatwarden/http/coop`, and not in the package root, because it uses `node:crypto`. It does nothing when you import it. It needs a
store that has `cw.links` (the memory store with `withMemoryLinks`, or SQLite from 0.1.12); without one, `coop(...)` throws a `RangeError`.

### Set up, in order

1. **Run Coop.** Use Coop's own Docker Compose set-up. In Coop, open Settings, then API Keys. Make an API key. Copy the **Webhook Signature Verification Key** too.
   It is a public key in PEM form.
2. **Create things in Coop by hand.** Coop has no way to create item types, policies or actions from outside, so the adapter prints a checklist. Call
   `adapter.setup.checklist().toText()` once and follow it. It lists the three item types and their fields, one policy for each of your Community Rules, and the
   actions to make. Each action gets the callback URL (your public URL plus `/coop/actions`) and **user strikes off**.
3. **Copy the ids into the options.** Coop gives each item type, policy and action an id. Put them in `itemTypes`, `actions` and `rules` (below).
4. **Add it to your server.** The route needs the exact request body, so use an adapter that supplies `rawBody` (`toExpress` does), with no body parser before it. The block below is the whole wiring.

```ts
import express from 'express';
import { coop } from '@chatwarden/http/coop';
import { toExpress } from '@chatwarden/http/express';

const adapter = coop(cw, {
  baseUrl: process.env.COOP_URL!, // https, or http on localhost for a local Coop
  apiKey: process.env.COOP_API_KEY!,
  webhookPublicKey: process.env.COOP_WEBHOOK_KEY!, // the PEM from Settings, API Keys
  itemTypes: { user: process.env.COOP_TYPE_USER!, line: process.env.COOP_TYPE_LINE!, report: process.env.COOP_TYPE_REPORT! },
  evidence: 'excerpt', // required: 'none' or 'excerpt'. There is no default.
  actions: {
    [process.env.COOP_ACTION_WARN!]: { verdict: 'upheld', kind: 'warning' },
    [process.env.COOP_ACTION_CHAT_24H!]: { verdict: 'upheld', kind: 'chat', durationMs: 86_400_000 },
    [process.env.COOP_ACTION_DISMISS!]: { verdict: 'no_action' },
  },
  rules: { [process.env.COOP_POLICY_HARASSMENT!]: 2 }, // Coop policy id -> Community Rule number
});

const app = express();
app.use('/', toExpress(adapter.routes)); // POST /coop/actions, with no body parser before it

// at startup
console.log(adapter.setup.checklist().toText()); // while you set Coop up
adapter.setup.verify().then((result) => console.log(result)); // read-only: three GETs
void adapter.sweep(); // send the open reports from the last day that have no job yet

// on shutdown
adapter.dispose();
```

5. **Check it.** `adapter.setup.verify()` makes three read-only requests and says which configured ids Coop does not list, which actions have no meaning
   here, and which item types lack a field. It writes nothing and never returns your key. `{ ok: false, status: 401 }` means Coop refused the key.
6. **File a test report** and watch the job appear in Coop. Decide it there with one of your actions and watch the hub close the report.

`adapter.sweep()` sends every open report from the last `catchUpMs` (default one day) that has no job yet. Run it at startup. A crash between Coop's answer and
the kit's note of it sends that report once more at the next sweep. Coop then counts a second report on the same item. That is the only cost.

### Coop options

| Option | What it does |
| --- | --- |
| `baseUrl` | Where Coop is. `https`, or `http` on `localhost` and `127.0.0.1`. No user, password, query or fragment. Redirects are never followed. Required. |
| `apiKey` | Sent as `X-API-KEY`. A secret: never logged, never in a result. Required. |
| `webhookPublicKey` | Coop's Webhook Signature Verification Key, a public RSA key in PEM form. A private key is refused. Required. |
| `itemTypes` | `{ user, line, report }`: the ids of the three item types you made in Coop. Required. |
| `evidence` | `'none'` or `'excerpt'`. Required, no default. `'none'` sends the category, rule, severity and room tags only. `'excerpt'` also sends the chat lines of the report. |
| `includeNote` | Send the reporter's note. It is player text. Default `false`. |
| `handles` | `'hidden'` (default) labels people `reporter`, `reported`, `other 1`. `'shown'` also sends each line's handle. |
| `policies` | `{ byReason, byRule }`: which Coop policy a report is filed under. A reported reason wins over the suggested rule. Optional. |
| `actions` | Coop action id to the kit decision it means (below). Required. An id that is not listed is acknowledged and ignored. |
| `rules` | Coop policy id to a Community Rule number. Without a match, the report's suggested rule is used. |
| `role` | The kit role the callbacks act with. Default `moderator`. A permanent ban needs `senior`. |
| `permissions` | Overrides of the minimum roles, checked as for the staff routes. |
| `callbackAuth` | `{ header, value }`. Coop can send a header you set on each action. When this is set, a callback without it gets the same `401`. Compared in constant time. |
| `catchUpMs` | How far back `sweep()` looks. Default 24 hours; at most 30 days. |
| `aiSeverity` | `(report) => number`. The kit's AI severity, 0 to 100. It rides in the item as `aiSeverity`, so a Coop routing rule can sort by it. A throw, or a value outside 0 to 100, drops that field and not the report. |
| `signal` | `{ secret, read, rateLimit? }`. Adds `POST /coop/signal` (below). Off unless set. |
| `fetch`, `schedule`, `clock`, `random`, `logger` | The `fetch` for Coop, the timer for the signal's time limit, the time source, the retry jitter and where failures are logged. All for tests; the defaults are the global ones. |

`adapter.routes` is the route table. `adapter.sweep()` resolves with `{ sent, skipped, failed }`. `adapter.setup` has `checklist()` and `verify()`.
`adapter.dispose()` unsubscribes, aborts the request in flight, clears every timer and drops the queue; nothing is written after it, and a disposed adapter's
routes answer `401`. The names `coop`, `CoopAdapter`, `CoopOptions`, `CoopDecision`, `SweepResult`, `CoopChecklist`, `CoopChecklistItemType` and `CoopVerification`
are `@experimental` until 0.2.

### The three item types

Make these in Coop, with exactly these field names. Names are case sensitive. `adapter.setup.checklist()` prints the same list.

| Item type | Field | Coop type | Required |
| --- | --- | --- | --- |
| Player (`user`) | none | | |
| Chat line (`line`) | `text` | `STRING` | yes |
| | `author` | `STRING` | yes |
| | `datetime` | `DATETIME` | yes |
| | `handle` | `STRING` | no |
| Report (`report`) | `category` | `STRING` | yes |
| | `reportedReason` | `STRING` | no |
| | `rule` | `NUMBER` | no |
| | `aiSeverity` | `NUMBER` | no |
| | `room` | `STRING` | no |
| | `creator` | `RELATED_ITEM` | yes |

The report is the item. Its id in Coop is the kit's report id, so every callback names exactly one report. A line is not used as the item, because a one-tap
report has no line and two reports can name one line. `author` is `reporter`, `reported` or `other n`. `room` is the room's own tags as `key=value` pairs, cut to
200 characters. `creator` is the reported player. The ids the kit sends for people are its own opaque staff refs, never a hash of an account. The kit never
sets `csam`: it does not detect it. Coop's own pipelines do.

### Which Coop actions mean what

`actions` maps a Coop action id to one of these:

| You write | The kit does |
| --- | --- |
| `{ verdict: 'upheld', kind: 'warning' }` | A warning on the reported player. |
| `{ verdict: 'upheld', kind: 'chat', durationMs }` | A chat restriction for that long. `kind: 'area'` and `kind: 'ban'` work the same. A ban with no `durationMs` is permanent. |
| `{ verdict: 'noted' }` | A note on the player. Nothing is done to them. |
| `{ verdict: 'no_action' }` | Closes the report as within the rules. |
| `{ verdict: 'bad_faith' }` | Closes the report and marks it as bad faith. The Coop decision reason is stored as the evidence; with no reason the callback is ignored. |

The sanction always lands on the person the report is about. Nothing in a Coop callback can pick another person, a role, an actor or a source. The decision is
recorded with the source `coop`, the actor `coop:<the moderator's email>` and the role you configured, and the audit trail gets a `report.decide` row.

The Community Rule is the first of the callback's policies that `rules` maps to a rule you can still cite. Otherwise it is the report's suggested rule. If there
is none, a decision that acts on a player (a warning, a restriction, a ban, a note) is ignored. A dismissal and a bad-faith mark need no rule.

### The callback

`POST /coop/actions` is the one URL for every action. In order, and each step refuses without doing anything else:

1. The body must be at most 64 KiB (`413`) and the adapter must have the exact bytes (`rawBody`; if not, `500` and a log line).
2. The `Coop-Signature` header must verify over those exact bytes with `webhookPublicKey` (RSA, SHA-256). The `t=<time>,v1=<signature>` form the docs also show is
   accepted, for the body alone or for `<t>.<body>`.
3. When `callbackAuth` is set, its header must match.
4. Only then is the body read. It must be JSON with an `item.id` and an `action.id` (`400` if not).
5. A callback no moderator made is ignored: one with no `actorEmail` (a rule), or with empty `policies` and `rules` (a strike threshold).
6. The report is read. An unknown report is ignored.
7. The action id is looked up in `actions`. An unknown one is ignored.
8. The decision is built, then made through the same path as the hub, as `role`. A refusal is ignored.
9. A store failure is a `503`, so Coop retries. The decision is all-or-nothing, so a retry is safe.

Every verification failure (a missing or malformed header, a wrong key, a changed byte) is the same `401 { "error": "unauthorized" }`. Everything else that
Coop could retry in vain is `200 { "ok": true, "outcome": "ignored" }`, with the reason in the log as `chatwarden.coop_callback_ignored`. An applied decision answers `"applied"`
as its outcome, and the same decision again answers `"replay"`. Nothing else is in the body.

The reason codes are `no_actor`, `no_policies`, `unknown_item`, `closed`, `unknown_action`, `no_rule`, `no_reason`, `forbidden` and `refused`.

### When two places decide

- **The first decision wins.** If the report was decided in the hub (or by a webhook, or from Discord) before Coop's callback arrives, the callback is answered
  `ignored` with the reason `closed` and applies nothing. The job stays in Coop, because Coop's API cannot close it. A reviewer may open a job whose case is
  already settled.
- **A repeated callback is harmless.** The same decision twice is applied once. The second is answered `replay`.
- **A decision the kit cannot apply is not guessed.** An unknown action, a policy with no rule, a bad-faith mark with no reason, or a permanent ban from a
  role below `senior` is answered `ignored`, and the report stays open for the hub. A `4xx` would only make Coop retry five times.
- **Nothing unattended.** A rule-triggered action or a strike threshold is never applied. Make the actions with user strikes off. The kit's own ladder is the
  only strike logic.
- **Ignore sends nothing.** Coop's Ignore and "Invalidate reports" are not known to send a callback. A job closed with Ignore leaves the report open in the
  hub. Use a Dismiss action (`{ verdict: 'no_action' }`) instead.

### Privacy

Chat text leaves the kit only where you say so, and only to your own Coop. There are three switches: `evidence` (no default), `includeNote` (off by default) and `handles` (hidden by
default). With `evidence: 'none'` no chat line is sent at all. With `handles: 'hidden'` no handle is sent.
The room id, the seat ids, client keys and IP addresses are never sent. A report that Coop gets holds the staff refs of the reporter and the reported player,
and nothing that identifies either outside the kit.

A log line carries an event name, an operation, an HTTP status or an error class, and a count. It never holds your key, a URL, a report id, a person, a note
or any chat text. The events are `chatwarden.coop_failed`, `chatwarden.coop_callback_ignored` and the queue's `chatwarden.coop_dropped`.

A Coop decision's `actorNote` and `decisionReason` are staff text. They are stored only as the decision's private reason (cut to 500 characters). They are in
no log, no event and no answer.

### The signal route (optional)

With `signal: { secret, read }` the adapter also serves `POST /coop/signal`. A Coop plugin can post the lines of a reported thread and get back a severity
from 0 to 100, which a Coop rule can compare with a threshold. The copy-in plugin is in `examples/coop-signal` in this repository. It is not published.

```ts
const adapter = coop(cw, {
  // ...the options above...
  signal: {
    secret: process.env.COOP_SIGNAL_SECRET!, // at least 32 characters
    read: async (lines) => myAiRead(lines), // your function: [{ label, text }] in, a number from 0 to 100 out
  },
});
```

The request is signed with the kit's own scheme: the headers `x-chatwarden-timestamp` and `x-chatwarden-signature`, a five minute window and a replay
cache. A bad signature, a stale or future time, a replay and a wrong secret are all the same `401`. The body is `{ lines: [{ label, text }], item?: { text } }`
and at most 64 KiB. At most 50 lines are read, each text is cut to 400 characters, and the item text is added as a last line. Extra keys are ignored and never
reach `read`. No identifier is in the request or the answer. The answer is `200 { "severity": n }`, with `n` kept between 0 and 100.

If `read` throws, takes more than 8 seconds, or answers something that is not a number, the answer is `503` with an empty body. More than `rateLimit`
requests (default 60 a minute) is `429` with `retry-after`. Your own AI cost limits apply inside `read`. The route only reads: it never decides anything.

### Coop: security notes

- **Verify before parse.** The callback is checked over the exact bytes before the body is read. The signal route is the same.
- **Replays.** Coop's signature carries no time, so a captured callback stays valid. A replay is harmless because the decision is idempotent and a closed report
  is acknowledged, not because it is fresh. A callback that was ignored for a configuration reason (`no_rule`, `unknown_action`, `forbidden`) can still be replayed after you fix
  the configuration, so a captured one can apply a stale but genuine decision to a report that is still open. The remedy is to rotate the verification key. If the key leaks, rotate it in Coop.
- **Rate-limit the routes at your edge.** A request with a bad signature still costs a body read and a signature check.
- **No secret leaves.** Keep the API key, the signal secret and `callbackAuth` out of source control.
- **Redirects are never followed.** The key is sent only to the `baseUrl` you set.

### Not confirmed yet

This adapter was written from Coop's public docs and tested against a fake that follows them. Nothing has run against a real Coop. The owner's local
end-to-end run (`docs/plans/follow-ups.md`) settles these:

- Which signature header Coop 1.2.2 sends: the base64 body signature, or `t=...,v1=...`. The adapter accepts both.
- That Ignore, Invalidate reports and Move send no callback.
- That `creator` is honoured as a relation field and that `datetime` is the field Coop orders a thread by (the kit sends it at the top level of each line
  and in its `data`).
- Coop's names for the field types, and whether a report job evaluates signals when a rule routes it.
- The plugin types package: Coop's docs say `@roostorg/coop-types`, its example imports `@roostorg/types`.

## Epic Online Services

`@experimental` until 0.2. This adapter connects the kit to [Epic Online Services](https://dev.epicgames.com/docs/web-api-ref/web-api-introduction) (EOS) in two ways.
When a moderator sanctions a player, the sanction is also made in EOS, and when the kit lifts it, EOS lifts it. When players report each other through EOS, those
reports become kit reports for the moderators, when your server can place both players in the same room.

The kit stays the source of truth. EOS gets a mirror of what the kit decided. An outage at EOS never changes what the kit does.

It is in its own entry, `@chatwarden/http/eos`, and not in the package root, because it uses `node:crypto`. It does nothing when you import it. It needs a store
that has `cw.links` (the memory store with `withMemoryLinks`, or SQLite from 0.1.12); without one, `eos(...)` throws a `RangeError`. You can turn on either half alone.

### What EOS's API can and cannot do

- A trusted server can create, read and remove sanctions. EOS gives each sanction a `referenceId`. The push uses that.
- A trusted server can send and find player reports, but **it cannot list them all.** The find call needs a player id. So the adapter asks about the players you name,
  the players who are in rooms right now.
- An EOS report has no id, no room, no chat line and no time you can trust. The reporting client writes the time and the text. So the adapter files a report in the kit
  only when your server can seat **both** players in the **same room**. Every other report is counted and left out. It is never invented.
- The kit stores no EOS id. You give it two small functions, one in each direction (below).

### Set up, in order

1. **Make client credentials in the EOS Developer Portal** for your product and deployment. Use a sandbox deployment first. Give the client a client policy that allows
   `sanctions:createSanction`, `sanctions:deleteSanction`, `sanctions:findSanctionsForAnyUser` and `playerreports:findReportsForAnyUser`. The first two are the push. The
   lookup before each create needs the third. The pull needs the fourth. Copy the deployment id, the client id and the client secret. Keep them out of source control.
2. **Choose the action names.** An EOS action is a name you pick, such as `chatwarden-chat`. Your game client reads active sanctions by these names. Use only `A-Z a-z 0-9 _ -`, up to 64 characters.
3. **Write the two functions.** `sanctions.productUserIdsOf` turns a person into their EOS product user ids. `reports.seatOf` turns a product user id into the seat that player holds now.
   The kit already holds your own account ids: `cw.people.accountIds(subject)` returns the strings you passed as `accountId` when the player took a seat.
4. **Add it to your server.** The block below is the whole wiring.

```ts
import { eos } from '@chatwarden/http/eos';

// Your own tables. The kit stores no EOS id.
const productUserIdOfAccount = new Map<string, string>(); // your account id -> EOS product user id
const seatOfProductUserId = new Map<string, { roomId: string; seatId: string }>(); // set when a player takes a seat

const adapter = eos(cw, {
  deploymentId: process.env.EOS_DEPLOYMENT_ID!,
  clientId: process.env.EOS_CLIENT_ID!,
  clientSecret: process.env.EOS_CLIENT_SECRET!, // a secret: never logged
  sanctions: {
    // The kit gives the person's staff ref. You give back their EOS product user ids.
    productUserIdsOf: (subject) => cw.people.accountIds(subject).flatMap((account) => productUserIdOfAccount.get(account) ?? []),
    actions: { chat: 'chatwarden-chat', area: 'chatwarden-area', ban: 'chatwarden-ban' },
  },
  reports: {
    seatOf: (productUserId) => seatOfProductUserId.get(productUserId) ?? null,
    players: () => [...seatOfProductUserId.keys()], // who to ask EOS about
  },
});

// at startup
adapter.start(); // poll for reports every minute

// on shutdown
adapter.dispose();
```

5. **Check it by hand** against your sandbox deployment. The steps are in `docs/plans/follow-ups.md` (task E5). Nothing has run against the real EOS yet.

`adapter.pollReports()` is one poll, for tests or your own schedule. It resolves with `{ seen, filed, skipped, refused }`: how many reports EOS returned, how many became
kit reports, and what was left out or refused, counted by reason code. `adapter.start()` polls every `pollMs` on a timer that does not keep Node running, and skips a tick
if the last poll is still running. `adapter.stop()` ends the timer. `adapter.dispose()` unsubscribes, aborts what is in flight, clears every timer and drops the queue;
nothing is written after it. The names `eos`, `EosAdapter`, `EosOptions`, `EosKind`, `EosSeat` and `PollResult` are `@experimental` until 0.2.

### Epic Online Services options

| Option | What it does |
| --- | --- |
| `deploymentId` | Your EOS deployment id. Required. |
| `clientId` | The client id of your credentials. No colon. Required. |
| `clientSecret` | The client secret. A secret: never logged, never stored, never in an error. Required. |
| `baseUrl` | Default `https://api.epicgames.dev`. Only for tests: `https`, or `http` on `localhost` and `127.0.0.1`. No user, password, query or fragment. Redirects are never followed. |
| `sanctions` | Turns on the push. Needs `productUserIdsOf` and `actions`. |
| `sanctions.productUserIdsOf` | `(subject, aliases) => string[]`. Yours. `subject` is the person's staff ref and `aliases` is every subject merged into it. Return one id for each account. An empty list, a throw or a bad answer pushes nothing. At most 20 ids are used. |
| `sanctions.actions` | `{ chat, area, ban, warning }`: the EOS action name for each kind. Name at least one. A kind with no name is not pushed. A `note` is never pushed. |
| `sanctions.justification` | `'ref'` (default) sends "Chatwarden M-7K3Q9, Rule 2". `'reason'` sends the moderator's private reason instead, cut to 2048 characters. |
| `sanctions.includeAutomatic` | Also push the automatic 30 minute chat timeouts. Default `false`. Needs `actions.chat`. |
| `reports` | Turns on the pull. Needs `seatOf` and `players`. |
| `reports.seatOf` | `(productUserId) => seat or null`, a seat being `{ roomId, seatId }`. Yours. Where that player sits now, from your own session table. |
| `reports.players` | `() => string[]`. Yours. The product user ids to ask EOS about this poll. At most 500 are used. |
| `reports.reasons` | EOS reason id (1 to 7) to a kit reason id, or `null` for no reason. It is merged over the defaults: 1 and 2 `cheating`, 3 and 7 `other`, 4 `harassment`, 5 and 6 `spam`. |
| `reports.pollMs` | How often `start()` polls. Default 60 000. At least 1000. |
| `reports.batch` | How many players go in one request. Default 20, at most 100. |
| `reports.maxPerPoll` | The most new reports one poll handles. Default 100, at most 1000. |
| `fetch`, `clock`, `random`, `logger` | The `fetch` for EOS, the time source, the retry jitter and where failures are logged. All for tests; the defaults are the global ones. |

### The push: a kit sanction becomes an EOS sanction

When a sanction of a kind you named is written, the adapter queues one job. The jobs run one at a time, in order. For each product user id the adapter:

1. Skips it if `cw.links` already has a row for this sanction and this id.
2. Looks at the user's sanctions in EOS for one whose `cw_ref` metadata is this sanction's reference code. If it finds one, it writes the row and stops. This is what stops a
   second sanction after a crash between EOS's answer and the kit's note of it. It reads at most 500 sanctions. If it cannot find ours in them, it creates nothing and logs it.
3. Creates the sanction in EOS: your action name, `source` `chatwarden`, `duration` in seconds (rounded, at least 1; `0` for a permanent ban and for a warning), the tags `cw` and
   `rule<n>`, the metadata `cw_ref` and `cw_rule`, and the justification.
4. Writes the row: a hash of the id, and EOS's `referenceId`. Nothing else.

When the kit revokes the sanction, the adapter finds the same ids again and removes each EOS sanction that has an active row, with the justification `Lifted: M-7K3Q9`. A sanction
that ended by itself needs nothing: EOS ends it by its duration.

Failures are retried like the kit's other adapters: 10 seconds for each attempt, then 1, 2, 4, 8 and 16 seconds, a 429's `retry-after` honoured (1 to 60 seconds), at most 1000 jobs
waiting. A 401 gets a new token once. A 400 or a 403 is final and logged. A failure at EOS never changes the kit's own sanction.

What EOS never gets: the moderator's reason (unless you chose `'reason'`), a handle, a chat line, a subject id, the report, or the actor.

### The pull: an EOS report becomes a kit report

Each poll asks EOS for reports **about** your players, 20 at a time, 50 to a page, oldest first, starting 10 minutes before the cursor. For each report the adapter:

1. Makes a key from a hash of its time, both player ids and the reason. EOS gives a report no id. If the key is known, the report is skipped. That is how the 10 minute overlap and a second poll are safe.
2. Asks your `seatOf` for both players. If either is not seated, or they are in different rooms, or the reporter and the reported are the same player, the report is skipped and counted
   (`unseated`, `different_room`, `self`). The reporter's seat comes from `seatOf` and nothing else. Nothing in the report picks the room or the person.
3. Files it with `cw.reports.submit`: the reason from `reports.reasons`, the message as the note (cut to 500 characters), and a line only if the `context` is JSON with a `lineId` that
   is a short string of visible characters (64 at most). The rest of `context` is ignored. The kit's own checks decide: the 10 reports a day, a suspended reporter, an unknown reason.
   A refusal is counted by its code (`rate`, `suspended`, `reason_unknown`, ...) and not tried again.
4. Writes the row (`filed` or `skipped`) and moves the cursor to the newest report time seen. The cursor never moves backwards, and never past now plus one minute, so a client cannot push it
   into the future. A report's `createdAt` is always the kit's own clock.

The first poll starts from now. It does not read the history from before the adapter started. A poll handles at most `maxPerPoll` new reports; the rest wait for the next poll, and the cursor
stays behind them. It reads at most 20 pages for each batch. A report whose time is more than 10 minutes before the cursor is not found: EOS is asked only for newer ones. A `429` pauses polling for its `retry-after` (1 to 60 seconds,
60 if it names none). A bad page, a `5xx` or a network failure ends that batch only: it is logged by status or class, the other batches are still read, and the cursor stays behind
what that batch had read, so its players are asked about again. A `400`, `404`, `405`, `413`, `414` or `422` on the first page of a batch means EOS refused the request itself (a bad id, say). Asking again
would get the same answer, so that batch does not hold the cursor; its reports are lost for that poll. Only a `429` stops the whole poll.

What is not covered. If a report is filed and the row that says so cannot be written, the next poll writes the row again and does not file the report twice, but only while the server keeps running: a restart in between
can file it a second time. If `seatOf` fails for a report and keeps failing for more than 10 minutes, that report is not found again, because the cursor has moved on and EOS is asked only for newer ones.

An EOS report is weak evidence. The kit files what its own checks accept and the moderator decides. You will not see every EOS report in the hub, only the ones your server can place.

### What stays on the game client

Reading a player's active sanctions, to show "you are sanctioned" or to stop a login, is an EOS SDK call your game client makes. So is sending a report from the game's own menu. They need
the local player to be signed in to EOS, and they are not the kit's job. The kit's own notices still tell the player the rule and the reference code. EOS appeals are not read in this release.

### Logs

Logs hold an event name, an operation, an HTTP status or an error class, and a count. Never an id, a URL, a header, a token, a secret, a message, a context or a reason.

| Event | When |
| --- | --- |
| `chatwarden.eos_failed` | A push or poll step failed. `op` says which: `token`, `resolve`, `reconcile`, `create`, `link`, `apply`, `revoke`, `players`, `seat`, `poll`, `submit`, `enqueue`. With `status` or `error`, and `attempts` for a job that gave up. |
| `chatwarden.eos_dropped` | The queue was full and dropped its oldest jobs. With a `count`. |
| `chatwarden.eos_revoke_no_link` | A lift found no link for an account, so nothing was sent to EOS: the sanction was never pushed (the adapter was off, or the push failed for good), or the row is gone. With a `count` only. An `active` link is kept by retention however old, so a sanction lifted long after it was pushed is still removed. |
| `chatwarden.eos_report_skipped` | A poll left reports out. With a `reason` (`unseated`, `different_room`, `self`, `malformed`, `seat_error`, or `refused_<code>`) and a `count`. |

### Epic Online Services: security notes

- **The secret and the token stay in memory.** The client secret goes into the Basic header for each token request and nowhere else. The access token is held until 60 seconds before it expires. Neither is logged, stored or put in an error.
- **The host is fixed.** Requests go to `https://api.epicgames.dev`. Redirects are never followed. The `baseUrl` option exists for tests.
- **Reports are hostile input.** Every field of an EOS report is written by a player's client. Each is shape-checked and cut before use, and the rest is ignored.
- **No outside account id is stored.** The rows in `cw.links` hold a hash and EOS's `referenceId`.
- **A line decides the person.** If a report's `context` names a `lineId` that is still in the room's evidence, the kit reports the author of that line, as it does for a report made in the game. Both players must still be seated in the same room.

### Not confirmed yet

This adapter was written from EOS's public Web API pages and tested against a fake that follows them. Nothing has run against the real EOS. The owner's sandbox run
(`docs/plans/follow-ups.md`) settles these:

- That `duration: 0` means permanent on create. The pages say so for a pending sanction; the example for create uses it.
- The most `reportedPlayerId` values one find call takes. The default batch is 20.
- EOS's rate limits. The pages state none. The adapter backs off on a 429 and a 5xx.
- That a delete of a sanction EOS no longer has answers `404`, and what the error bodies look like.
- That the create accepts `automated`, which the example shows and the field table does not list.
- What EOS answers to the user query for a player who has no sanctions at all. The adapter reads a `404` as "none found" and goes on to create the sanction. If EOS answers something else, the first sanction for a player is not created and the log shows the status.
- The link of an EOS sanction that is still `active`, and the poll cursor, are never purged by age. A link marked `removed` is purged with the reports (90 days by default).
- A restart between the kit's revoke and the delete leaves the EOS sanction in place until it expires. A sweep that fixes this is not built.

## Health probes

`healthRoutes(cw)` adds two public routes. They say "up" or "not ready" and never why.

- `GET /healthz`: 200 `{ "ok": true }`. Liveness: the process answers. It never touches the store.
- `GET /readyz`: 200 `{ "ok": true }` while the store answers; otherwise 503 `{ "ok": false }`. The failure is logged with the
  error class only.

Use `/healthz` for "restart me" checks and `/readyz` for "send me traffic" checks.

## Other servers: `toFetch`

`toFetch` serves the same route tables from a Web `Request`, so a Next.js route handler, a Bun or Deno server, a Worker or Hono can use the kit. It is what `chatwarden init --framework next`, `fetch` and `fastify` write. It imports no Node module, so it also runs in a browser bundle.

```ts
import { adminRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toFetch } from '@chatwarden/http/fetch';

// Route tables by the path they live under. The key '' is the probes.
const handle = toFetch(
  {
    '/admin': adminRoutes(cw, { authorize }),
    '/api': playerRoutes(cw, { identify: (req) => ({ clientKey: req.headers['x-player-token'], ip: req.remoteAddress }) }),
    '': healthRoutes(cw),
  },
  { prefix: '/chatwarden' },
);

// Next.js:  export const GET = handle; export const POST = handle;
// Bun:      Bun.serve({ fetch: handle });
// Hono:     app.all('/chatwarden/*', (c) => handle(c.req.raw));
```

`handle(request)` resolves to the kit's `Response`. The longest mount key that owns the path wins, and the prefix and the key are removed before a table sees the path, so the tables `toExpress` takes work as they are. A path no mount owns is the kit's JSON 404, or `null` with `unmatched: 'pass'` so your own router can answer it. A wrong method is the kit's 405 with an `allow` header.

| Option | Meaning |
| --- | --- |
| `prefix` | Where the mounts are rooted in the URL, such as `/chatwarden`. Default: none. |
| `maxBody` | The largest request body read, in bytes (1 to 16 MiB). Default 65536. A larger body is the kit's 413, and a stream that passes the cap is cancelled. |
| `remoteAddress` | The socket's address, if your host can tell (Bun: `server.requestIP`). It is never read from a header. Default: none. |
| `unmatched` | `'not_found'` (default) or `'pass'`. |
| `logger` | Where the adapter logs (the event and the error class only). Default `console.warn`. |

The request body is read as the exact UTF-8 text the Express adapter gives, so a signature check sees the same bytes. A response with a stream (the chat) is a streaming `Response`, stopped when the client leaves. A handler error is the kit's 500 with no stack. Next.js and the other hosts must run as a long-lived Node process for the chat stream and a database file: see [the Next.js recipe](../../docs/recipes/nextjs.md).

`toFetch`, `Mounts`, `FetchOptions` and `FetchHandler` are `@experimental` until 0.2.

## Writing another adapter

`toExpress` and `toFetch` are the adapters that ship, but the routes are plain functions, so an adapter for Koa or your own host is
a few lines. `createRouter(routes)` gives you `(req) => Promise<KitResponse>`. When your framework needs to tell "this path
is not mine" from "mine, and the answer is 404", use `matchRoute(routes)`, which is what `toExpress` uses. It returns a
`CompiledRoutes` with two methods:

- `run(req)` answers every request: a handler's response, 404 for a path no route has, and 405 (with an `allow` header) for a
  known path under another method. It does not catch handler errors; the builders (`adminRoutes` and the rest) already wrap
  theirs in `withErrors`.
- `matches(path, method?)` is the question to ask first. True means the path is the table's, so answer it with `run`. False
  means no route fits the path under any method, so hand the request back to your framework (`toExpress` calls `next()`)
  before you read the body. A handler that answers 404 is a match; only "no route at all" is false. The query string is ignored.
  Pass the request method so a CORS preflight (`OPTIONS`) to a known path stays your app's, unless a route answers `OPTIONS`.

Also: `HEAD` runs the `GET` handler, so send its status and headers but not its body. A malformed route key throws a
`RangeError` when you call `matchRoute`, not when a request arrives.

```ts
import { matchRoute, type KitResponse, type RouteTable } from '@chatwarden/http';

export function mount(routes: RouteTable, forward: (path: string) => void): (method: string, path: string) => Promise<KitResponse | null> {
  const compiled = matchRoute(routes);
  return async (method, path) => {
    if (!compiled.matches(path, method)) {
      forward(path); // not the kit's: let your framework carry on
      return null;
    }
    // Read the body only now, then build a KitRequest and call compiled.run(req) to get the KitResponse to send.
    return null;
  };
}
```

## Security notes

- **A player response never holds an identifier.** No subject id, key, hash, IP, room, group id, moderator, reason or other
  player's text. Staff responses do carry subject ids (staff need them); keep `/admin` behind your own login.
- **`GET /blocked` returns raw chat lines.** They are lines the filter refused, with the subject that typed each one. Staff
  already read raw lines in a report's excerpt; this lists them without a report, so it has its own permission
  (`blocked.read`) and every call is audited (`blocked.view`). Give it only to people who may read them.
- **Claims are a courtesy, not a lock.** They stop a second moderator acting on a case by accident, and nothing else: a claim never
  hides a case or blocks a read, a webhook (`webhookIn`) is not held up by one (once it has decided the person's last open report, it releases whoever held the case), and a senior with `claims.override` can take
  one over (on the record, `case.takeover`). The check and the write are two steps, so a claim taken in between is not seen. The
  actor names in `by`, `viewing` and `viewers` are staff refs, shown only to staff.
- **Every staff request is authenticated and audited.** The audit row is `{ at, actor, role, action, target }` where the
  target is an id. It never stores chat text, reasons, notes or evidence. A view is audited before it is shown: if the row
  cannot be written, the answer is 500 and nothing is shown.
- **The moderator's reason, the rule-gap note, the reporter's note and the moderator's identity are never shown to a player.**
- **`GET /gaps` returns the gap notes in bulk.** Moderators write them as free text, and one request reads every note. Tell
  moderators to never paste chat into a gap note (describe what the rules did not cover instead), and give `gaps.read` only to
  people who may see all of them.
- **Error messages are fixed text** and never repeat request input.
- **Bodies are JSON only, up to 64 KiB** (413 above), and a body with a `__proto__`, `constructor` or `prototype` key is refused.
- **Webhook secrets** are at least 32 characters and are never logged, nor are webhook URLs. Outgoing deliveries go over
  `https:` (plain `http:` only to localhost) and redirects are not followed.
- **Rate-limit `webhookIn` at the edge,** and consider limiting `/admin` and `/api` there too. The kit only limits name checks.
- **`remoteAddress` is a socket address.** Decide for yourself how to find the real client address behind a proxy.
- **Events and webhook bodies are for staff only** (see above). Do not forward `onReport` reports or events to a player.
- **Retention.** The kit deletes old rows on a timer (see `retention` in `createChatwarden`); call `cw.close()` on shutdown.
