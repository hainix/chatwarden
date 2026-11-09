**Chatwarden is open-source chat moderation for games and anyone with a chat. It is not a child-safety tool: for CSAM detection and reporting, use [Coop](https://github.com/roostorg/coop) and [HMA](https://github.com/facebook/ThreatExchange/tree/main/hasher-matcher-actioner).**

# Chatwarden

Status: pre-release, as-is, no support promise; PRs welcome.

## Packages

| Package | Description |
| --- | --- |
| [`@chatwarden/core`](packages/core) | Moderation engine. No runtime dependencies; imports nothing from `node:` except `node:crypto`. |
| [`@chatwarden/store-sqlite`](packages/store-sqlite) | SQLite-backed store for sanctions, strikes and reports. |
| [`@chatwarden/matcher`](packages/matcher) | Text matcher that resists Unicode evasion without blocking innocent words. |
| [`examples/tiny-chat`](examples/tiny-chat) | A one-room Express + `ws` chat server wired through `createChatwarden` (private, not published). |

## Development

Requires Node 22.13 or newer (`nvm use` reads `.nvmrc`).

```sh
npm ci
npm run typecheck
npm run lint
npx vitest run packages/core/test/smoke.test.ts   # run tests by path
```

`npm test` runs the whole suite and is meant for CI.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
