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

## Reports

`POST /v1/reports` (design 10.6): a term id, a closed kind (`innocent_sense`, `wrong_category`, `removal`) and a day. A report is signed by an
installation (the kind `report`, no stamp) or, for the docs-site form, carries a Turnstile token (`{ schema, termId, kind, token }`; the
secret is `TURNSTILE_SECRET`). No free text is read or stored: a body with any other key is refused and the table has no column for it. One open
report per term, per channel (an installation, or a keyed hash of the network) and day; a second collapses into the first. The reporter gets an
acknowledgement id and nothing about the term. The web form is the only route that answers a browser: set `REPORTS_ORIGIN` to the docs site's
origin and `REPORTS_HOSTNAME` to the host a token must have been solved on. In the review page, one reviewer's confirmation of an innocent-sense
or wrong-category report disputes the term; a removal of a slur takes two reviewers (one for other terms); restoring takes two.

## The review page

`/admin/*` (the page in `page/admin/`, served from Workers Static Assets, and its API) sits behind a Cloudflare Access application. The Worker
checks the Access JWT itself (RS256, the team's certs, issuer and audience), then that the email is an active row of `reviewers`. The owner
keeps that table by hand:

```
wrangler d1 execute chatwarden-corpus --command "INSERT INTO reviewers (email, fluent) VALUES ('name@example.org', '[\"en\"]')"
```

`fluent` is a JSON array of language tags. `reviewer_installations` lists the installation hashes (sha256 of the raw public key, hex) a reviewer
controls: they cannot review those submissions. The lists never carry a word or a note; a reveal does, and is counted, audited and reminds the
reviewer to take a break every 20. Rules (design 10.3), enforced in SQL: the first approval makes a term provisional, the second by a different
reviewer makes it accepted when one approver is fluent, a slur needs a target, one reviewer's word disputes a term and two restore it, and every
action writes an audit row in the same transaction.

## Owner actions

Written up with the tools (later tasks): create the D1 database and the R2 bucket, apply `schema.sql`, set the secrets
(`COUNTER_SECRET`, `TURNSTILE_SECRET`), set the Access application, then `wrangler deploy`.

## Checks

```
npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts
```
