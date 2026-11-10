**Chatwarden is open-source chat moderation for games and anyone with a chat. It is not a child-safety tool: for CSAM detection and reporting, use [Coop](https://github.com/roostorg/coop) and [HMA](https://github.com/facebook/ThreatExchange/tree/main/hasher-matcher-actioner).**

# Chatwarden

Status: pre-release, as-is, no support promise; PRs welcome.

## Packages

| Package | Description |
| --- | --- |
| [`@chatwarden/core`](packages/core) | Moderation engine. No runtime dependencies; imports nothing from `node:` except `node:crypto`. |
| [`@chatwarden/store-sqlite`](packages/store-sqlite) | SQLite-backed store for sanctions, strikes and reports. |
| [`@chatwarden/matcher`](packages/matcher) | Text matcher that resists Unicode evasion without blocking innocent words. |
| [`@chatwarden/profanity`](packages/profanity) | Optional ordinary-swearing filter (allow, star or refuse; style, add, remove, custom list). Slurs stay the matcher's job. |
| [`@chatwarden/http`](packages/http) | HTTP routes: the staff API (reports, decisions, sanctions, terms, audit), the player API (notices, record, rules), health probes, signed webhooks in and out, and an Express adapter. |
| [`@chatwarden/discord`](packages/discord) | Posts the staff review queue into a Discord forum through a channel webhook, one thread per reported person. |
| [`examples/tiny-chat`](examples/tiny-chat) | A one-room Express + `ws` chat server wired through `createChatwarden`, the kit's HTTP routes and an optional Discord feed (private, not published). |

## Install

Pick what you need. `@chatwarden/core` is a peer dependency of every other package, so you install it yourself and your
project gets exactly one copy of it. `store-sqlite` and `profanity` also need `matcher` as a peer.

| I want to | Install |
| --- | --- |
| Moderate chat: the engine, a store and a slur matcher | `npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher` |
| Give moderators and players HTTP routes (Express) | add `npm install @chatwarden/http express @types/express` |
| Mask or refuse ordinary swearing | add `npm install @chatwarden/profanity` |
| Post the review queue into a Discord forum | add `npm install @chatwarden/discord` |
| Try it with invented test words, no real term list | nothing extra: `@chatwarden/matcher/fixtures` is part of `@chatwarden/matcher` |

Express 5 ships no types, so `@types/express` goes with `express` in a TypeScript project (a plain JavaScript project can skip it).

Each package has its own README with the options, a copy-paste start and its security notes: [core](packages/core), [store-sqlite](packages/store-sqlite), [matcher](packages/matcher), [profanity](packages/profanity), [http](packages/http), [discord](packages/discord).

## Quick start

Add the kit to a server that already has chat. The engine (`createChatwarden`) decides; `@chatwarden/http` puts it behind
routes; `@chatwarden/discord` is optional.

```ts
import express from 'express';
import { createChatwarden } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import { discordFeed } from '@chatwarden/discord';

const cw = await createChatwarden({ store: openStore({ path: './chatwarden.db' }), secret, platform, matcher, profile: 'standard' });

const app = express();
// Mount the kit BEFORE any body parser: it reads the raw body itself.
app.use('/admin', toExpress(adminRoutes(cw, { authorize: (req) => yourModeratorLogin(req) }))); // { actor, role } or null
app.use('/api', toExpress(playerRoutes(cw, { identify: (req) => ({ clientKey: req.headers['x-player-token'], ip: req.remoteAddress }) })));
// The probes last, by habit: a kit mounted at '/' passes paths that are not its own to the next handler, so nothing is hidden.
app.use(toExpress(healthRoutes(cw))); // /healthz, /readyz

// Optional: a Discord forum thread per reported person.
discordFeed(cw, { webhookUrl: process.env.DISCORD_WEBHOOK_URL!, hubLink: (kind, id) => `https://mod.example.com/${kind}s/${id}` });
```

- `authorize` and `identify` are the only two hooks you write. The kit never sees a password or a token.
- Full setup, the permissions table, the error codes and the webhook format: [`packages/http/README.md`](packages/http/README.md).
- The Discord forum setup and its limits: [`packages/discord/README.md`](packages/discord/README.md).
- A runnable example with a chat server: [`examples/tiny-chat`](examples/tiny-chat).

## Pick a preset

One line chooses your game's written standard (what counts as rude or hostile, what happens first, what counts as repeated):

```ts
const cw = await createChatwarden({ profile: 'relaxed', store, secret, platform, matcher, profanityPackage });
// 'relaxed' (trash talk is fine), 'standard' (the default) or 'strict' (younger players and families)
```

The preset sets the suggestions a moderator sees, the starter Community Rules, the profanity mode and a one-line
`cw.summary` to show players. Change single fields with `overrides`; the rest of the preset stays, and a list you give
replaces the preset's list instead of adding to it:

```ts
createChatwarden({ profile: 'relaxed', overrides: { profanity: { mode: 'allow' } }, /* ... */ });
createChatwarden({ profile: 'relaxed', overrides: { profanity: { remove: ['damn', 'hell'] } }, /* ... */ });
```

`cw.documents.codeOfConduct({ format: 'html', gameName })` writes the players' code of conduct from the same profile.
See the [moderation standards](docs/design/2026-11-09-moderation-standards.md) for the exact tables behind each preset.

Always pass a term pack (a slur `matcher`): profanity starring is not slur protection.

## CommonJS

The packages are ESM only. A CommonJS app can still `require()` them on Node 22.13 or newer (and 24): Node loads an ES module
from `require()` as long as it has no top-level `await`, and none of the Chatwarden packages has one. On older Node, use
`await import(...)`.

For types, a TypeScript project with `module: commonjs` and `moduleResolution: node` does not read the `exports` map. The
subpaths (`@chatwarden/http/express`, `@chatwarden/matcher/fixtures`) are found through `typesVersions` in each package, so
`import { toExpress } from "@chatwarden/http/express"` type-checks. CI installs the packed tarballs into a fresh CommonJS
project (TypeScript 5.7, `moduleResolution: node`) and runs them.

## Node support

Node 22.13 or newer. CI tests on Node 22.13 and Node 24, both the full suite and an install of the packed packages into a
fresh project. `@chatwarden/store-sqlite` uses the `node:sqlite` module that ships inside Node.

## Releasing, and using it before the first release

How a release is made, and how to install the packages from tarballs before they are on npm: [RELEASING.md](RELEASING.md).
A worked example of a real app adopting the kit, with its decisions and phasing: [Moxgate](docs/adoption/moxgate.md).

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
