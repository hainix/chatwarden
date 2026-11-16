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

## Owner actions

Written up with the tools (later tasks): create the D1 database and the R2 bucket, apply `schema.sql`, set the secrets
(`COUNTER_SECRET`, `TURNSTILE_SECRET`), set the Access application, then `wrangler deploy`.

## Checks

```
npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts
```
