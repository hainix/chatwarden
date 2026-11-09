# tiny-chat

A one-room chat server (Express + `ws`) wired to Chatwarden through `createChatwarden`: the smallest end-to-end example.

```sh
npm install                       # from the repo root
npm start -w @chatwarden/example-tiny-chat
```

Connect a WebSocket client to `ws://127.0.0.1:3000/?key=anything` and send `{"type":"chat","text":"hello"}`.
Anything the server sends back is `{type:'welcome'|'chat'|'refused', ...}`; see the header of `server.ts`.
`POST /report` files a report (`{ key, targetSeat, category }`).

The store is in-memory (`openStore({ path: ':memory:' })`), so everything resets on restart.

**The term list here is synthetic.** The demo blocks invented words (such as `zorbak`) from
`@chatwarden/matcher/test-fixtures`, which is a test fixture and is not published. A real adopter installs a term
pack, loads it with `loadTermPack`, and passes `new LiveTerms({ store, pack, clock })` as the `matcher` option.
