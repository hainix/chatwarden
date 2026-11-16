# @chatwarden/corpus-service

The service behind the shared term list (design `docs/design/2026-11-12-k7-term-corpus.md`): it takes one-term submissions and reports,
holds the review queue and the term database, and builds the releases the maintainer signs. It is a **private workspace**: it is never
published to npm, never in a release run, and nothing in it deploys by itself.

Everything here runs in tests with no Cloudflare account. D1, R2 and Cloudflare Access sit behind small interfaces (`src/env.ts`); the
tests use a D1-shaped adapter over `node:sqlite` (`test/d1.ts`) and a Map-backed bucket (`test/r2.ts`). The code holds **no term, no list and
no key**: tests use invented words and keys generated at run time, and `scripts/no-corpus-data.mjs` guards the repo.

## Layout

- `schema.sql`: the D1 tables (design 6.9). Idempotent.
- `wrangler.jsonc`: placeholders only (no account or database id).
- `src/env.ts`: the typed bindings.
- `test/`: the D1 and R2 fakes and the tests.

## The submission API

`POST /v1/submissions` and `GET /v1/submissions/:id` (design 6.8). The kit's share client is the contract and the tests drive it against the app
(`test/world.ts`). The order of the checks is the order of their cost: content type, size (2 KiB, enforced while reading), the hashcash
stamp (16 bits), the Ed25519 signature, the decline lock and the limits (20 a day per installation, 60 a day per network hash, 200 pending),
then the body, the day window (the server's UTC day, one either side) and the gates. A request is counted only after it has paid for its
stamp and signed. The network address (`cf-connecting-ip`) is turned into a keyed hash that changes every day (`COUNTER_SECRET`) and is never
stored or logged; an IPv6 address counts as its /64. Logs hold `{ stage, code }` and nothing else. A cron trigger purges counters after two
days and notes 90 days after a decision.

## Owner actions

Written up with the tools (later tasks): create the D1 database and the R2 bucket, apply `schema.sql`, set the secrets
(`COUNTER_SECRET`, `TURNSTILE_SECRET`), set the Access application, then `wrangler deploy`.

## Checks

```
npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts
```
