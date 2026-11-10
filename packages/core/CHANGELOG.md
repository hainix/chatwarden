# @chatwarden/core

## 0.1.1

### Patch Changes

- Runs in a browser: the hashing and random ids no longer import any node: module (node:crypto is used when the runtime has it, a pure-JS SHA-256 and HMAC-SHA256 otherwise), and hashes are byte-identical to 0.1.0. Adds cw.chat.restricted(who, { roomId, seatId }), the same decision as accept without sending a line, for typing indicators. Exports the RestrictedAnswer type for it. A failing restriction lookup on that path is logged at most once a minute.

## 0.1.0

### Minor Changes

- First public release.
