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
