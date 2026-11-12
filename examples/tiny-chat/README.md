# tiny-chat

A one-room chat server (Express + `ws`) wired to Chatwarden through `createChatwarden`: the smallest end-to-end example.

```sh
npm install                       # from the repo root
npm start -w @chatwarden/example-tiny-chat
```

Connect a WebSocket client to `ws://127.0.0.1:3000/?key=anything` and send `{"type":"chat","text":"hello"}`.
Anything the server sends back is `{type:'welcome'|'chat'|'refused'|'notices'|'acked', ...}`; see the header of
`server.ts`. The `welcome` frame carries `summary`, the profile's one-line standard ("Trash talk is part of the game. Harassment,
threats and hate are not."), to show above the chat. A `refused` frame may carry `rule` (show it as "Community Rule N") and `noticeId` (the player's own notice that
explains the refusal). `POST /report` files a report (`{ key, targetSeat, category }`).

The rest of the HTTP surface is the kit's own routes from `@chatwarden/http`, mounted with its Express adapter
(`toExpress` from `@chatwarden/http/express`): `/admin/*` is the staff API (`adminRoutes`), `/api/*` the player API
(`playerRoutes`), and `/healthz` and `/readyz` the probes (`healthRoutes`). The adapter reads the raw body itself, so it
is mounted **before** any body parser: tiny-chat parses JSON only on its own `POST /report` route.

Two error shapes appear in this demo. The kit routes answer `{ "error": <code>, "message": ... }`. The demo's own `POST /report`
and its "admin API is off" switch (a 404 when no admin token is set) keep the legacy shape `{ "ok": false, "refused": ... }`;
that shape belongs to those two only.

The player API identifies the caller from `x-chatwarden-key` (or the demo's `?key=`) and the socket address, which the
adapter hands over as `req.remoteAddress` (never a header, so a client cannot choose it). Behind a reverse proxy that is the
proxy's address: parse `X-Forwarded-For` in your own `identify`, trusting only your own proxy.

## Discord feed (optional)

Off unless `DISCORD_WEBHOOK_URL` is set. With it, tiny-chat starts the `@chatwarden/discord` feed: each reported player gets one
thread in a Discord forum channel, and the report, the decision, any automatic timeout and a lifted sanction are posted into it.

```sh
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/<id>/<token>' DISCORD_MENTION_ROLE_ID='<role id>' TINY_CHAT_ADMIN_TOKEN=demo npm start -w @chatwarden/example-tiny-chat
```

- `DISCORD_WEBHOOK_URL` is the forum channel's webhook (see [`packages/discord/README.md`](../../packages/discord/README.md) for how
  to make one). It is a credential: keep it out of the repository. A value that is not a Discord webhook URL stops the server
  at startup. Empty counts as unset.
- `DISCORD_MENTION_ROLE_ID` is optional: the role to ping on a severe report (category `hate`) or a severe sanction. Without
  it nobody is pinged.
- The links in the posts point at this demo's own staff routes, `http://127.0.0.1:<port>/admin/reports/<id>` and
  `http://127.0.0.1:<port>/admin/people/<subject>/history`. Open them with the `x-admin-token` header (the admin API is off
  without `TINY_CHAT_ADMIN_TOKEN`). A real app links to its moderator console.
- Posts hold no chat text, handle, note or reason, and ids only inside those links.
- `startServer({ discordWebhookUrl, discordMentionRoleId, discordFetch })` takes the same settings as options. An option that is
  passed wins over the environment, and an empty string passed as an option forces the feed off (or the ping off) even when the
  shell exports a value; an option that is left out falls back to the environment. `discordFetch` replaces `fetch` for tests.

## AI reads (demo, optional)

Off unless `CW_DEMO_AI=1`. With it, tiny-chat wires a scripted fake AI (`createFakeModerationAI`: it reads a report by simple rules, with no
key, no SDK and no network) at level 2, so the whole flow can be seen in the hub: every new report gets a read, the case page shows the
strip, and the decision form arrives pre-filled with a mild step you can accept with one key.

```sh
CW_DEMO_AI=1 TINY_CHAT_ADMIN_TOKEN=demo npm start -w @chatwarden/example-tiny-chat
```

- It is a demo, not a moderator: the fake calls any report with a line by the reported player "rude" and cites their first line. A real
  app passes its own adapter instead; see [`examples/ai-anthropic`](../ai-anthropic/README.md) and the "Turning on AI reads" section of
  [`docs/adoption/moxgate.md`](../../docs/adoption/moxgate.md).
- The level is a code override here (2), so the owner can still lower it, or switch it off, in the hub's Settings.
- `startServer({ demoAi })` takes the same switch as an option. An option that is passed wins over the environment (`false` forces it
  off); only the exact value `1` turns the environment variable on.
- Nothing about the AI changes without it: no adapter, level 0, no read on any report.

## The profile, swearing and the code of conduct

tiny-chat runs the one-line preset `profile: 'relaxed'` with the optional `@chatwarden/profanity` package
(`profanityPackage`). Under `relaxed` ordinary swearing is starred, never refused, and never a strike, note or notice.
`startServer({ overrides })` changes single fields:

```ts
startServer({ overrides: { profanity: { mode: 'allow' } } });                 // no starring
startServer({ overrides: { profanity: { remove: ['damn', 'hell'] } } });      // take words off the list
```

`GET /api/code-of-conduct?format=html` serves `cw.documents.codeOfConduct({ format: 'html', gameName: 'tiny-chat' })`
(markdown by default, or `text`): plain generated HTML, sent with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'` (the kit's `CODE_OF_CONDUCT_CSP`).

**Profanity starring is not slur protection.** Slurs are the term pack's job (`matcher`); always pass one.

## Warnings and notices

A moderator decision (a warning, a restriction, a ban) writes a notice for the player. The server pushes
`{type:'notices', items}` when the player connects with notices waiting and whenever a decision adds one; the client
shows them and replies `{type:'ack', id}` (a warning must be acknowledged before the player's next game).
`platform.notify` is how the kit tells the server a player has a notice: it hands over a subject id, which the server
maps to a seat in its own connection map. The subject id never goes on the wire.

`GET /api/notices`, `POST /api/notices/:id/ack` and `GET /api/record` are the player API: the pending notices, the
acknowledgement, and the player's "My record". `GET /api/rules` lists the rules and `POST /api/names/check` checks a name.

**Demo only: the identity and the admin token are not secure.** The player API takes the key from the
`x-chatwarden-key` header and, as a demo convenience, from `?key=` in the URL, so anyone who knows a player's key can read
that player's record. A real app authenticates its players with its own session. `/admin` stands in for a moderator
console: it is guarded by a shared token in the `x-admin-token` header (set `TINY_CHAT_ADMIN_TOKEN`, or pass `adminToken`
to `startServer`; without one the whole admin API is off), with the role `owner` and a fixed actor `demo-admin`. A real
app authenticates its moderators with its own session, takes report ids from its moderator queue (`GET /admin/reports`
or `onReport`), and gives each moderator their own actor and role. The kit audits every staff request.

A decision names **subject ids**, not seats. Read them from the report, then decide:

```sh
curl http://127.0.0.1:3000/admin/reports/<id> \
  -H "x-admin-token: $TINY_CHAT_ADMIN_TOKEN"
```

The answer's `report.targetSubject` and `report.reporterSubject` are the ids (staff only: they never go to a player).

`/admin` also has the sanction, gap, term (the demo passes its `LiveTerms` as `terms`), policy and audit routes; see `adminRoutes`.

```sh
curl -X POST http://127.0.0.1:3000/admin/reports/<id>/decide \
  -H 'content-type: application/json' \
  -H "x-admin-token: $TINY_CHAT_ADMIN_TOKEN" \
  -d '{"verdict":"upheld","reason":"private note","actions":[{"subject":"<targetSubject>","kind":"warning","durationMs":null,"rule":2}]}'
```

`verdict` is `upheld`, `noted` (every action a `note`: recorded for staff, nothing sent to the player), `no_action` or
`bad_faith` (needs an `evidence` string).

If the store fails the route answers a bare 500 `{ "error": "internal" }` and writes nothing. A request the kit refuses
answers 400 (`invalid_request`, and the like), an unknown report 404, one already decided 409, a missing or wrong token
401. A subject the report does not name is refused.

## The moderator hub at /mod

Open `http://127.0.0.1:3000/mod` (with `TINY_CHAT_ADMIN_TOKEN` set) and sign in with the token: you get the moderator hub, Simple
mode, on the same reports your players file. It is the shortest adoption path, `@chatwarden/hub-element`, so tiny-chat needs no React
and no front-end build: the page is one script tag and one element, and `server.ts` serves the file the package ships.

```html
<script type="module" src="/mod/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>
```

- `GET /mod` is that page. `GET /mod/hub-element.js` is `node_modules/@chatwarden/hub-element/dist/hub-element.js`, served as it is.
  Run `npm run build` once from the repo root (`npm start` does it for the one package) so the file exists; without it the route answers
  503 and says so.
- The hub calls `/admin` on the same origin: `GET /admin/me` first, then the queue, the case and the decision. Nothing else is needed on
  the server: it is the staff API tiny-chat already mounts.
- **It sits behind the same authorize as `/admin`.** `/mod`, the script and the staff API all pass through one function, which wants the
  `x-admin-token` header or the session cookie below, and answers 401 otherwise. A browser cannot send a header on a page load, so an
  unsigned visitor to `/mod` gets a small sign-in form that posts the token to `POST /mod/login`. It answers with a `tiny_chat_staff`
  cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` over TLS) and sends the visitor back to `/mod`. The cookie goes along with the
  hub's own calls to `/admin`, which is how the element signs in (it sends the page's cookies to its own origin). A wrong token is 401 and
  sets nothing. `SameSite=Strict` is what stops another site from driving the staff API with that cookie.
- **DEMO ONLY.** The cookie holds the shared admin token. A real app signs its moderators in with its own session and puts that session
  in front of `/admin` and the page, in `authorize`; the hub needs nothing else.
- Without an admin token every `/mod` path is a 404, like `/admin`.
- The page sends a strict Content-Security-Policy: scripts and API calls only from the page's own origin, and one inline stylesheet by
  its hash (no `unsafe-inline`). See the hub-element README for what the element itself needs.

For React, `<Hub>` from `@chatwarden/hub-react` is the same hub as a component; this example uses the element because it needs no build.

## Staff-only vs player-facing

Some kit values carry subject ids (they name a person). They are for staff channels only, never for a player:
`onReport`'s `StoredReport`, the result of `decide` (its `groups`), `history`, `suggest`, `gaps.list` and
`rooms.subjectAt`. Keep them on the server or in a moderator queue. The demo never calls `suggest`; a moderator console that does must pass
the report's `roomId` as `{ roomId }` whenever the profile's `repeat.distinctGames` is true (`relaxed`), or note escalation
never fires.

What a player may see: a `PlayerNotice` (from `notices.pending` and `notices.record`), a `refused` frame (a reason, an end
time, a rule number and a notice id) and a reference code to quote to a moderator. The demo server follows this: it
turns a subject into a seat on the server, and no player-facing frame or response carries a subject id, a key or a hash.
(The staff API shows ids, because staff need them.)

The store is in-memory (`openStore({ path: ':memory:' })`), so everything resets on restart.

**The term list here is synthetic.** The demo blocks invented words (such as `zorbak`) from
`@chatwarden/matcher/fixtures`, the synthetic pack the matcher package ships for tests and demos. A real adopter installs a term
pack, loads it with `loadTermPack`, and passes `new LiveTerms({ store, pack, clock })` as the `matcher` option.
