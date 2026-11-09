# tiny-chat

A one-room chat server (Express + `ws`) wired to Chatwarden through `createChatwarden`: the smallest end-to-end example.

```sh
npm install                       # from the repo root
npm start -w @chatwarden/example-tiny-chat
```

Connect a WebSocket client to `ws://127.0.0.1:3000/?key=anything` and send `{"type":"chat","text":"hello"}`.
Anything the server sends back is `{type:'welcome'|'chat'|'refused'|'notices'|'acked', ...}`; see the header of
`server.ts`. A `refused` frame may carry `rule` (show it as "Community Rule N") and `noticeId` (the player's own notice that
explains the refusal). `POST /report` files a report (`{ key, targetSeat, category }`).

## Warnings and notices

A moderator decision (a warning, a restriction, a ban) writes a notice for the player. The server pushes
`{type:'notices', items}` when the player connects with notices waiting and whenever a decision adds one; the client
shows them and replies `{type:'ack', id}` (a warning must be acknowledged before the player's next game).
`platform.notify` is how the kit tells the server a player has a notice: it hands over a subject id, which the server
maps to a seat in its own connection map. The subject id never goes on the wire.

`GET /record?key=...` returns the player's "My record".

**Demo only: `/record` and `/decide` are not secure.** `/record` trusts a key passed in the URL, so anyone who knows
a player's key can read that player's record. `/decide` stands in for a moderator console: it is guarded by a shared
token in the `x-admin-token` header (set `TINY_CHAT_ADMIN_TOKEN`, or pass `adminToken` to `startServer`; without one
the route is off), names seats instead of people, and uses a fixed actor. A real app authenticates its players and
its moderators with its own sessions, takes report ids from its moderator queue (`onReport`), and records who decided.

```sh
curl -X POST http://127.0.0.1:3000/decide \
  -H 'content-type: application/json' \
  -H "x-admin-token: $TINY_CHAT_ADMIN_TOKEN" \
  -d '{"reportId":"<id from onReport>","verdict":"upheld","reason":"private note","actions":[{"seat":"p1","kind":"warning","durationMs":null,"rule":2}]}'
```

`decide` rejects with the store's own error if the store fails (the route answers a bare 500 and writes nothing); a
decision the kit refuses answers 422.

## Staff-only vs player-facing

Some kit values carry subject ids (they name a person). They are for staff channels only, never for a player:
`onReport`'s `StoredReport`, the result of `decide` (its `groups`), `history`, `suggest`, `gaps.list` and
`rooms.subjectAt`. Keep them on the server or in a moderator queue.

What a player may see: a `PlayerNotice` (from `notices.pending` and `notices.record`), a `refused` frame (a reason, an end
time, a rule number and a notice id) and a reference code to quote to a moderator. The demo server follows this: it
turns a subject into a seat on the server, and no frame or response carries a subject id, a key or a hash.

The store is in-memory (`openStore({ path: ':memory:' })`), so everything resets on restart.

**The term list here is synthetic.** The demo blocks invented words (such as `zorbak`) from
`@chatwarden/matcher/test-fixtures`, which is a test fixture and is not published. A real adopter installs a term
pack, loads it with `loadTermPack`, and passes `new LiveTerms({ store, pack, clock })` as the `matcher` option.
