# @chatwarden/http

HTTP routes for Chatwarden, the open-source chat moderation kit for games. It gives you:

- the **staff API** (`adminRoutes`): the report queue, decisions, sanctions, rule gaps, term lists, policy documents and the audit trail;
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

Staff, under the prefix you mount (`/admin` above). Each one is authenticated, needs a permission (see Permissions below), and writes an audit row, except `GET /me`.

| Route | What it does |
| --- | --- |
| `GET /me` | Who is calling: `{ actor, role, can }`, where `can` is a boolean for every permission under the table in force (your `permissions` overrides included). It needs only a signed-in caller, and writes no audit row. |
| `GET /reports?status&cursor&limit` | The queue, newest first, as summaries: `id`, `createdAt`, `roomId`, `tags`, `category`, `status`, `badFaith`, `targetPerson`, `reporterPerson`, `actionedAt`, `actionedBy`. No chat text, handles or notes. |
| `GET /reports/:id?level` | One report with its excerpt, notes, each person's history and a suggestion. This is where evidence is read, so it is audited with the report id. |
| `POST /reports/:id/suggest` | `{ level, rule?, person? }`: a suggestion for a person the report names (default: the reported person). |
| `POST /reports/:id/decide` | `{ verdict, reason, actions, evidence? }`. A replay of the same decision applies nothing twice. |
| `GET /people/:ref/history` | A person's actions and recent reports against them. |
| `POST /sanctions` | `{ subject, kind, durationMs, rule, reason?, gapNote?, includeIp? }`. `durationMs` is required: milliseconds up to 365 days, or `null` for permanent. Answers `{ groupId, refCode }`. |
| `POST /sanctions/:groupId/revoke` | `{ reason }` (a non-empty string; blank is 400). Revokes the whole group. 404 if it is unknown or already revoked. |
| `GET /gaps` | Rule gaps (sanctions filed under no rule), newest first. Returns the moderator-written gap notes in bulk, so moderators must never paste chat into a gap note. |
| `POST /gaps/:groupId/close` | `{ status, ref }`: `status` is `ruled` (with `ref`, the number of the active rule that now covers it) or `not_a_rule` (`ref` null or absent). |
| `GET /terms` | The term and exception rows, text included. Only when you pass `terms`. |
| `POST /terms/check` | `{ term, language }`: a dry run, answers `{ hits }`. |
| `POST /terms` | `{ term, language, note? }`. `PATCH /terms/:id` takes `{ term?, language?, note? }`; `POST /terms/:id/active` takes `{ active }`. |
| `POST /exceptions` | `{ phrase, language, note? }`. `PATCH /exceptions/:id` and `POST /exceptions/:id/active` work like the term ones. |
| `GET /policy?format` | The code of conduct, moderator guide and agent brief, generated from your profile and rules. |
| `GET /audit?cursor&limit&actor&action` | The audit trail, newest first. |

Players, under `/api` above. None needs a staff login.

| Route | What it does |
| --- | --- |
| `GET /notices` | Notices not yet acknowledged, oldest first. |
| `POST /notices/:id/ack` | `{ ok }`. `ok: false` (still 200) for a notice that is not the caller's, so ids cannot be probed. |
| `GET /record` | The caller's sanction notices that still apply. |
| `GET /rules` | `{ summary, rules }`: active rules as `{ number, title, text }`. |
| `GET /code-of-conduct?format=html\|markdown\|text` | The generated document (markdown by default). HTML is sent with a strict `content-security-policy`. |
| `POST /names/check { name }` | Whether a display name is allowed. Limited to 20 a minute per identity (`namesRateLimit`). |

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
| `history.read` | moderator | `GET /people/:ref/history`. |
| `gaps.read` | moderator | `GET /gaps`. |
| `gaps.close` | owner | `POST /gaps/:groupId/close`. |
| `terms.read` | moderator | `GET /terms`, `POST /terms/check`. |
| `terms.write` | moderator | Adding, editing and switching terms and exceptions. |
| `policy.read` | moderator | `GET /policy`. |
| `audit.read` | senior | `GET /audit`. |
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
| `invalid_profile` | 400 | The moderation profile is not valid. |
| `invalid_sanction` | 400 | The core refused the sanction (a warning with a duration, an uncovered rule with no gap note, ...). |
| `invalid_rules` | 400 | The rules are not valid. |
| `invalid_excerpt` | 400 | The notice excerpt is not valid. |
| `invalid_term` | 400 | The matcher refused a term change. |
| `invalid_gap_ref` | 400 | Closing a gap as `ruled` needs the number of an active rule. |
| `invalid_idempotency_key` | 400 | The incoming webhook's key is missing or malformed. |
| `unauthorized` | 401 | `authorize` returned nobody, or a webhook signature did not verify. |
| `forbidden` | 403 | The caller's role is below the permission's. |
| `not_found` | 404 | No such id, path, or the group was already revoked. |
| `method_not_allowed` | 405 | The path exists under other methods; the `allow` header lists them. |
| `already_decided` | 409 | The report was decided already, differently. |
| `in_progress` | 409 | An incoming-webhook request with this idempotency key is still running. Retry later. |
| `idempotency_mismatch` | 409 | The idempotency key was used with a different request. |
| `payload_too_large` | 413 | The body is over 64 KiB. |
| `rate_limited` | 429 | Too many name checks; `retry-after` says how long. |
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
