# @chatwarden/http

HTTP routes for Chatwarden, the open-source chat moderation kit for games. It gives you:

- the **staff API** (`adminRoutes`): the report queue, decisions, sanctions, rule gaps, term lists, policy documents, the editable moderation profile and the audit trail;
- the **player API** (`playerRoutes`): a player's notices, "my record", the rules, the code of conduct and a name check;
- **health probes** (`healthRoutes`);
- **signed webhooks**, outgoing (`webhooksOut`) and incoming (`webhookIn`);
- an **Express adapter** (`toExpress`, from `@chatwarden/http/express`);
- a **browser-safe entry** (`@chatwarden/http/admin`): the staff API, `createRouter` and the error, role and permission exports, with nothing that imports a Node builtin, so a browser app can run the staff routes in the page.

The routes are plain functions over a small request and response type, so the package has no web framework in it. Express
is the only adapter that ships; `createRouter` lets you write another.

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
| `GET /me` | Who is calling: `{ actor, role, can }`, where `can` is a boolean for every permission under the table in force (your `permissions` overrides included). It needs only a signed-in caller, and writes no audit row. |
| `GET /reports?status&reason&cursor&limit` | The queue, newest first, as summaries: `id`, `createdAt`, `roomId`, `tags`, `category`, `reportedReason`, `reportedReasonLabel`, `status`, `badFaith`, `targetPerson`, `reporterPerson`, `actionedAt`, `actionedBy`, `targetHandle`, `reporterHandle`, `claim`, `viewing`. `targetHandle` and `reporterHandle` are the reported person's and the reporter's handle as they were when the report was filed (null if none was recorded), so a row can show a name; they are staff-only, like the report page. `claim` is `{ by, since, until }` when another moderator (or you) is handling the reported person's case, else null, and `viewing` lists the other staff who have the case open right now (see the team routes below); both are empty for a report that is no longer open. No chat text or notes. `reportedReason` is the reason the reporter gave (an id from the profile's reporting reasons; an old category reads as its new id, `disruption` as `griefing`), or null; `reportedReasonLabel` is its label as it is now (the id when the reason has since been removed, null when none was given). It is a hint, never the truth. `reason` filters on it: a reason id (the old `disruption` finds `griefing`), or `none` for the reports that gave no reason; a malformed value is 400 `invalid_query`, and an id nobody used is an empty page. |
| `GET /reports/:id?level` | One report with its excerpt, notes, each person's history and a suggestion. This is where evidence is read, so it is audited with the report id. The answer is `{ report, history, suggest, rule, claim }`. `report` also has `reportedReasonLabel` beside `reportedReason`, and `detailAt` (when the reporter added their follow-up, or null). `rule` is the first still-citable rule of the reported reason, or `"uncovered"` when no reason was given (the moderator picks). `claim` is the claim on the reported person's case (`{ by, since, until }` or null). A claim never stops anyone reading. |
| `POST /reports/:id/suggest` | `{ level, rule?, person? }`: a suggestion for a person the report names (default: the reported person). |
| `POST /reports/:id/decide` | `{ verdict, reason, actions, evidence? }`. A replay of the same decision applies nothing twice. If another moderator holds a live claim on the reported person, the answer is 409 `claimed` (with `by` and `until`) and nothing is written, unless the body also has `takeOver: true` and the caller holds `claims.override`: then the case moves to the caller, an audit row `case.takeover` is written first, and the decision goes ahead. A successful decision of the person's last open report releases the caller's own claim; while other reports about the same person are open the claim is kept untouched (one case per person), so nobody else can take the case from the moderator working through it. |
| `GET /people/:ref/history` | `{ history, reports, sanctions, asReporter, handle }`. `handle` is the person's handle on the newest report filed against them that recorded one, or null. `history` and `reports` are the person's counted actions and the recent reports against them. `sanctions` is a list of sanction groups, newest first: the last 90 days plus every group still in force (a permanent one that has not been revoked, or a restriction that has not ended), at most 200 (the groups in force are always kept; the cap trims the oldest of the rest), each `{ groupId, refCode, kind, rule, startsAt, endsAt, reason, actor, source, automated, active, pending, revokedAt, revokedBy, revokeReason }`. `rule` is a rule number, `"uncovered"`, or null on a row written before rules existed; `endsAt` is null for a permanent sanction and for a warning or note (which have no end); `active` is about time and revocation only: true while a restriction has started, is not revoked and is not past its end, and for a warning or note while it is inside the 90-day window the escalation ladder counts; `pending` is true when the sanction was written while enforcement was off, so it applies nothing until enforcement is on (a hub can label it; it does not change `active`); the revoke fields are null until someone revokes it. A group is built from the person's own row, so no IP, hash or stored value is ever part of it. `asReporter` is how the reports this person *filed* stand: `{ reports, open, actioned, dismissed, badFaith, suspendedUntil, reasonMatched, reasonDecided }`, where `suspendedUntil` is the epoch ms their reporting suspension ends (`limits.reports`: that many bad-faith dismissals inside the window), or null, and `reasonMatched` of `reasonDecided` is how often the reason they gave was borne out by the decision (see the core README, "Reporting settings"). |
| `GET /sanctions?cursor&limit&source` | Every person's sanctions, newest first, `{ items, next }`: the same group object as above plus `person` (the canonical subject, a staff ref) and `handle` (the handle on the newest report filed against that person that recorded one, or null). `limit` is 1 to 200 (default 50, a bigger number is clamped), `cursor` is the previous `next` (null on the last page; a full page always carries one, so the page after an exactly-full last page is empty), `source` is one of `moderator`, `auto_filter`, `coop`, `api`, `ai`. A bad limit, cursor or source is 400 `invalid_query`. Not windowed. It audits `history.view` with no target, once per successful read (a page, a filter and a second look are each a row), as `GET /people/:ref/history` does for one person; a refused read (400, 403) writes none, and if the row cannot be written, the read fails (500) and returns nothing. |
| `GET /blocked?days=1\|7\|30` | The chat lines the slur filter blocked, newest first, at most 500: `{ items: [{ id, at, roomId, termId, term, language, person, handle, text }] }`. `days` defaults to 7; any other value is 400 `invalid_query`. `text` is the line exactly as the person typed it and `person` the canonical subject: staff only. `handle` is the name to show for them (the newest non-blank handle on a report filed against them), null when none recorded one or when the caller lacks `history.read`. `term` and `language` come from the `terms` you passed, and only when the caller also holds `terms.read` (the term text is that permission's); they are null without `terms`, for a term no longer listed, or for a caller who lacks `terms.read`, and `termId` and `text` are still there. The kit keeps these lines 30 days. Staff already read raw lines in a report's excerpt, so this is not a new kind of exposure, but it is a new way to reach it: it has its own permission, `blocked.read`, and writes an audit row, `blocked.view` (no target). |
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
| `POST /cases/next` | `{ category?, reason? }` (the body is optional). Claims and returns the oldest open case that nobody holds, `{ case: { person, reportId, claim } }`, or `{ case: null }` when there is none. A case is ordered by the person's oldest open report and opens on their newest (`reportId`); a case anyone holds, you included, is skipped without a write; `category` (one of the report categories, else 400) keeps only cases with an open report of it. `reason` (a reason id, the old `disruption` finding `griefing`, or `none` for reports that gave none; a malformed one is 400) keeps only cases with an open report that gave it; give both and both must hold. They are the only filters: the order is already oldest first, and there is no wait filter. Two moderators asking at once never get the same case. Needs `reports.decide`. |
| `POST /cases/:ref/viewing` | A heartbeat that you have the case open: `{ viewers: string[] }`, the other staff who do. A beat counts for 30 seconds. It is a hint kept in this server process's memory, never stored and never a lock, so a second server process does not see it. 404 `not_found` when the person has no open report (nothing is tracked, so made-up refs fill nothing), and one actor keeps at most 20 cases open: a newer beat drops their oldest. Needs `reports.read`. |
| `GET /changes?since=<token>` | `{ token, changed }`: a cheap check for a queue that polls. `token` is opaque (compare it, do not parse it); `changed` is false only when `since` is exactly the current token. It differs after a report is filed or decided, a sanction is applied or revoked, a rule gap is closed, a claim is taken, taken over or released, or a saved reason changes. A claim heartbeat, a claim that merely lapses, viewing and every read leave it alone. The token is kept in the store, so a restart does not rewind it and several server processes agree. One read, no audit row. `since` that is not a short token is 400 `invalid_query`. Needs `reports.read`. |
| `GET /reasons` | `{ reasons: [{ id, label, text, active }] }`, in the order they were added, switched-off ones included (a picker shows the active ones). Needs `reasons.read`. |
| `POST /reasons` | `{ label, text }` (trimmed; the label is up to 40 characters and the text up to 500, counted as characters so an emoji is one; at most 200 reasons; a label may hold no control character, a text none but a newline): answers `{ reason }`. Audited `reason.add` on the reason id. `PATCH /reasons/:id` takes `{ label?, text? }` (at least one) and `POST /reasons/:id/active` takes `{ active }`; both answer `{ reason }` and 404 for an unknown id, and are audited `reason.update` and `reason.toggle`. Need `reasons.write`. |
| `GET /policy?format&omit` | The code of conduct, moderator guide and agent brief, generated from your profile and rules. `omit=rules,ladder` leaves those sections out of the moderator guide (a UI that draws them from the data uses it); an unknown name is 400 `invalid_query`. |
| `GET /policy/profile` | The editable moderation profile: `{ effective, base, layer, version, canSave }`, plus `layerError` (`{ path, kind }`) when the stored layer cannot be used and is being ignored (`kind` is `unreadable` for stored text that could not be read at all, `invalid` for one that was read but is not valid). `effective` is what is in force (`base`, the profile from your code, with the owner's stored `layer` on top); `version` is the layer's version (0 when nothing was ever saved). `canSave` is false when your store cannot save settings. It looks at the store first, so it is never behind another process. Needs `policy.read`; audited `policy.view`. |
| `PUT /policy/profile` | `{ layer, version, reason }`: replace the stored layer, the whole layer (a section left out goes back to the base). `layer` may hold `durations`, `customDuration`, `ladder` (all 6 rows; a cell without a `label` gets one, such as "Restrict chat 6 hours"), `firstOffense`, `repeat`, `areaRules`, `severeRules`, `guidelines` (`[{ outcome }]`, one entry per tier, `null` to keep a tier) and `reporting` (`{ flow?, reasons?, thanks? }`: the report flow, the whole ordered list of reasons, each `{ id, label, hint?, group?, rules?, asksNote?, enabled? }`, and the thank-you copy; the audit section is named `reporting`); anything else, profanity included, is refused. `version` is the one you loaded; `reason` is 1 to 2000 characters. 200 `{ ok, changed, effective, base, layer, version, canSave }`: `changed` names the sections that differ, and the rest is the fresh state in the shape `GET` answers, so no second read is needed; it takes effect at once here and within 10 seconds in other processes. 409 `conflict` when someone saved since you loaded (reload and merge). 400 `invalid_profile` with `path` (the field in your layer, such as `layer.ladder[2].high.durationMs`) for a layer the kit refuses. 501 `not_supported` for a store that cannot save settings. Needs `policy.write`; audited `policy.update` with the sections changed and the reason, never the values. |
| `POST /policy/profile/preview` | `{ layer, rule? }`: what the candidate layer would suggest, `{ samples }`, for four fixed records (`clean`, `oneWarning`, `chat24h`, `ban7d`) at each conduct level, each as `{ label, kind, durationMs }`, and `reporting`, what a player would read of the candidate's reporting settings (the enabled reasons without any rule mapping, the flow and the thank-you) (`durationMs` is null for permanent and for a warning or note). Saves nothing and writes no audit row. `rule` is a Community Rule number, to see `areaRules` or `severeRules` take effect. An invalid layer is 400 `invalid_profile` with `path`. Needs `policy.read`. |
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
| `POST /names/check { name }` | Whether a display name is allowed. Limited to 20 a minute per identity (`namesRateLimit`). |

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
It exports `adminRoutes`, `createRouter`, the errors, `parseJson`, the roles and the permissions. It leaves out the player
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
| `sanctions.apply` | moderator | `POST /sanctions`, and any decision that carries actions. |
| `sanctions.apply.ban_permanent` | senior | A ban with `durationMs: null`, on top of `sanctions.apply`. |
| `sanctions.revoke` | moderator | `POST /sanctions/:groupId/revoke`. |
| `history.read` | moderator | `GET /people/:ref/history`, `GET /sanctions`. |
| `blocked.read` | moderator | `GET /blocked`. Raw blocked chat lines, so it is separate from `history.read`. The `term` text in it also needs `terms.read`. |
| `gaps.read` | moderator | `GET /gaps`. |
| `gaps.close` | owner | `POST /gaps/:groupId/close`. |
| `terms.read` | moderator | `GET /terms`, `POST /terms/check`, `POST /terms/test`. |
| `terms.write` | moderator | Adding, editing and switching terms and exceptions. |
| `policy.read` | moderator | `GET /policy`, `GET /policy/profile`, `POST /policy/profile/preview`. |
| `policy.write` | owner | `PUT /policy/profile`, `DELETE /policy/profile`. Editing the profile changes what every moderator is suggested, so it is the owner's. |
| `audit.read` | senior | `GET /audit`. |
| `claims.override` | senior | Taking over another moderator's claim (`takeOver: true` on a claim, a decision or a direct sanction). |
| `reasons.read` | moderator | `GET /reasons`. |
| `reasons.write` | senior | Adding, editing and switching saved reasons. |
| `settings` | owner | Reserved. No route uses it yet. |

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
| `invalid_sanction` | 400 | The core refused the sanction (a warning with a duration, an uncovered rule with no gap note, ...). |
| `invalid_rules` | 400 | The rules are not valid. |
| `invalid_excerpt` | 400 | The notice excerpt is not valid. |
| `invalid_term` | 400 | The matcher refused a term change. |
| `invalid_gap_ref` | 400 | Closing a gap as `ruled` needs the number of an active rule. |
| `invalid_idempotency_key` | 400 | The incoming webhook's key is missing or malformed. |
| `duration_not_offered` | 400 | The profile has `customDuration` off and the length is not one it offers. |
| `unauthorized` | 401 | `authorize` returned nobody, or a webhook signature did not verify. |
| `forbidden` | 403 | The caller's role is below the permission's. |
| `not_found` | 404 | No such id, path, or the group was already revoked. |
| `method_not_allowed` | 405 | The path exists under other methods; the `allow` header lists them. |
| `already_decided` | 409 | The report was decided already, differently. |
| `conflict` | 409 | The profile settings changed since the caller loaded them (`PUT` or `DELETE /policy/profile` with an old `version`). |
| `claimed` | 409 | Another moderator holds the case. The body also has `by` (who) and `until` (when the claim lapses, epoch ms). |
| `in_progress` | 409 | An incoming-webhook request with this idempotency key is still running. Retry later. |
| `idempotency_mismatch` | 409 | The idempotency key was used with a different request. |
| `payload_too_large` | 413 | The body is over 64 KiB. |
| `rate_limited` | 429 | Too many name checks; `retry-after` says how long. |
| `not_supported` | 501 | The store cannot save profile settings (it has no `savePolicyLayer`). |
| `internal` | 500 | Anything else. No detail is sent. |

## Webhooks

### Outgoing: `webhooksOut`

```ts
import { webhooksOut } from '@chatwarden/http';

const out = webhooksOut(cw, {
  endpoints: [
    { url: 'https://staff.example.com/chatwarden', secret: process.env.WEBHOOK_OUT_SECRET!, events: ['report.created', 'sanction.applied'] },
    // Chat text only if you really want it, to a receiver you control:
    // { url: '...', secret: '...', events: ['report.created'], includeExcerpts: true },
  ],
});
// on shutdown: out.dispose()
```

`events` is `'*'` or a list from `report.created`, `report.closed`, `sanction.applied`, `sanction.revoked`, `gap.created` and
`auto.restricted`. The URL must be `https:` (plain `http:` only for `localhost` and `127.0.0.1`) with no credentials in it. The
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
receiver you control and may show chat text to.

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

## Health probes

`healthRoutes(cw)` adds two public routes. They say "up" or "not ready" and never why.

- `GET /healthz`: 200 `{ "ok": true }`. Liveness: the process answers. It never touches the store.
- `GET /readyz`: 200 `{ "ok": true }` while the store answers; otherwise 503 `{ "ok": false }`. The failure is logged with the
  error class only.

Use `/healthz` for "restart me" checks and `/readyz` for "send me traffic" checks.

## Writing another adapter

`toExpress` is the only adapter that ships, but the routes are plain functions, so an adapter for Fastify, Koa or a Worker is
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
