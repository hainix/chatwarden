# @chatwarden/corpus-service

The service behind the shared term list (design `docs/design/2026-11-12-k7-term-corpus.md`): it takes one-term submissions and reports,
holds the review queue and the term database, and builds the releases the maintainer signs. It is a **private workspace**: it is never
published to npm, never in a release run, and nothing in it deploys by itself.

Everything here runs in tests with no Cloudflare account. D1, R2 and Cloudflare Access sit behind small interfaces (`src/env.ts`); the
tests use a D1-shaped adapter over `node:sqlite` (`test/d1.ts`) and a Map-backed bucket (`test/r2.ts`). The code holds **no term, no list and
no key**: tests use invented words and keys generated at run time, and `scripts/no-corpus-data.mjs` guards the repo. The real lists, the seed
and the dictionary live outside the repository (the design's `.corpus-data/`), and the tools below refuse to write them inside a git tree.

Status: pre-release, as-is, no support promise.

Nothing has been deployed.

## Layout

- `schema.sql`: the D1 tables (design 6.9). Idempotent.
- `wrangler.jsonc`: placeholders only (no account id, no database id). The Worker is served on its custom domain only (`workers_dev` is off).
- `src/worker.ts`, `arrival.ts`, `review.ts`, `reports.ts`, ...: the Worker (submissions, the review API, reports, the daily purge).
- `src/build/`: the release builder: `release.ts` (terms), `eval.ts` (eval and calibration sets), `gates.ts`, `diff.ts`, `zip.ts`, `templates.ts`.
- `src/tools/` and `tools/`: the maintainers' tools. The logic is TypeScript in `src/tools/`; each `tools/*.mjs` is a three-line launcher.
- `page/admin/`: the review page (static files, served by the Worker after Access and the reviewer check).
- `test/`: the fakes (`d1.ts`, `r2.ts`, `world.ts`, ...) and the tests.

## The submission API

`POST /v1/submissions` and `GET /v1/submissions/:id` (design 6.8). The kit's share client is the contract and the tests drive it against the app
(`test/world.ts`). The order of the checks is the order of their cost: content type, size (2 KiB, enforced while reading), the hashcash
stamp (16 bits), the Ed25519 signature, the decline lock and the limits (20 a day per installation, 60 a day per network hash, 200 pending),
then the body, the day window (the server's UTC day, one either side) and the gates. A request is counted only after it has paid for its
stamp and signed. The network address (`cf-connecting-ip`) is turned into a keyed hash that changes every day (`COUNTER_SECRET`) and is never
stored or logged; an IPv6 address counts as its /64. Logs hold `{ stage, code }` and nothing else. A cron trigger purges counters after two
days, notes 90 days after a decision and the installation hash of a decided submission after 180.

## Reports

`POST /v1/reports` (design 10.6): a term id, a closed kind (`innocent_sense`, `wrong_category`, `removal`) and a day. A report is signed by an
installation (the kind `report`, no stamp) or, for the docs-site form, carries a Turnstile token (`{ schema, termId, kind, token }`; the
secret is `TURNSTILE_SECRET`). No free text is read or stored: a body with any other key is refused and the table has no column for it. One open
report per term, per channel (an installation, or a keyed hash of the network) and day; a second collapses into the first. The reporter gets an
acknowledgement id and nothing about the term. The web form is the only route that answers a browser: set `REPORTS_ORIGIN` to the docs site's
origin and `REPORTS_HOSTNAME` to the host a token must have been solved on. In the review page, one reviewer's confirmation of an innocent-sense
or wrong-category report disputes the term; a removal of a slur takes two reviewers (one for other terms); restoring takes two, and the
reviewer who disputed the term, or confirmed a report that held it out, is not one of them. A confirmed wrong-category report has no
category-edit action yet (it holds the term out, like an innocent-sense one; see `docs/plans/follow-ups.md`).

## The review page

`/admin/*` (the page in `page/admin/`, served from Workers Static Assets, and its API) sits behind a Cloudflare Access application. The Worker
checks the Access JWT itself (RS256, the team's certs, issuer and audience), then that the email is an active row of `reviewers`. The owner
keeps that table by hand:

```sh
npx wrangler d1 execute chatwarden-corpus --remote --command "INSERT INTO reviewers (email, fluent) VALUES ('name@example.org', '[\"en\"]')"
```

`fluent` is a JSON array of language tags. `reviewer_installations` lists the installation hashes (sha256 of the raw public key, hex) a reviewer
controls: they cannot review those submissions. The lists never carry a word or a note; a reveal does, and is counted, audited and reminds the
reviewer to take a break every 20. Tabs: Queue, Held, Disputed, Provisional, Accepted, Withdrawn terms and Reports. Rules (design 10.3), enforced
in SQL: the first approval makes a term provisional, the second by a different reviewer makes it accepted when one approver is fluent, a slur
needs a target, one reviewer's word disputes a term and two restore it, and every action writes an audit row in the same transaction.

## Setting it up (the owner, once)

These are the design's owner actions 1 to 4 (section 17) as commands. Nothing is run for you, and no id, secret or key is ever committed:
`wrangler.jsonc` keeps its placeholders, and what you paste in below stays on your machine.

**1. Cloudflare.** Enable R2 on the account (it may ask for a card; set a billing alert), then log in once on the release machine:

```sh
npx wrangler login
```

**2. The database and the bucket.** Create them and apply the schema (the schema file is idempotent, so applying it again is safe):

```sh
npx wrangler d1 create chatwarden-corpus
npx wrangler r2 bucket create chatwarden-releases
npx wrangler d1 execute chatwarden-corpus --remote --file services/corpus/schema.sql
```

`d1 create` prints a `database_id`: paste it over `REPLACE_AT_DEPLOY` in your working copy of `wrangler.jsonc` and do not commit it.

**3. The two subdomains.** `releases.chatwarden.dev` serves the bucket read-only; `corpus.chatwarden.dev` is the Worker. The zone id is on the
domain's overview page in the Cloudflare dashboard:

```sh
npx wrangler r2 bucket domain add chatwarden-releases --domain releases.chatwarden.dev --zone-id <ZONE_ID>
```

For the Worker, uncomment the `routes` entry at the bottom of your working copy of `wrangler.jsonc` (`corpus.chatwarden.dev`, `custom_domain`).
Then add a Transform Rule (Rules, Transform Rules, Modify Response Header) for the host `releases.chatwarden.dev` that sets
`x-robots-tag: noindex, nofollow` and `x-content-type-options: nosniff` (design 6.1); the tools already upload the content types, the cache
headers and `content-disposition: attachment` for zips, and a `robots.txt` that disallows everything.

**4. Access and the reviewers.** In Zero Trust, create a self-hosted Access application for `corpus.chatwarden.dev/admin/*` with an email policy
for the reviewers. Copy the team domain (`<team>.cloudflareaccess.com`) and the application's audience tag into `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` in your working copy of `wrangler.jsonc`. Add each reviewer (see the command above, with their languages in `fluent`).

**5. The secrets** (names only; the values are never written to a file):

```sh
npx wrangler secret put COUNTER_SECRET
npx wrangler secret put TURNSTILE_SECRET
```

`COUNTER_SECRET` is any long random string (it keys the daily network hash). `TURNSTILE_SECRET` is the siteverify secret of the docs-site report
form; until it is set the web report form answers 403 (signed reports from installations work without it). For the web form also set
`REPORTS_ORIGIN` and `REPORTS_HOSTNAME` in `vars`.

**6. Deploy:**

```sh
npx wrangler deploy --config services/corpus/wrangler.jsonc
```

Cloudflare's own Workers logs record invocation metadata outside this service's logging: confirm in the dashboard that it keeps no client
address before `PRIVACY.md` is published as it stands.

## The local D1 smoke

Every test runs the service's SQL on `node:sqlite` through an adapter that follows D1. One more runs it on D1's own engine, **locally, with no
Cloudflare account**, through wrangler's local mode: the schema, the seed and the record SQL are applied with the owner's own `wrangler d1
execute --local` command, and the app, the review routes and the release builder then run against the real D1 binding (`RETURNING`, `changes()`
inside a batch, the partial unique indexes, the UNIQUE error text, `instr`). It also checks that the Worker bundles for deployment with the real
`wrangler.jsonc` (a dry run) and that `wrangler d1 export` writes a dump the `release` tool opens. It needs workerd (installed with the workspace) and takes about a
minute, so it does not run with the other tests; it is skipped, with the reason, unless asked for. Run it before the first deploy and after any
change to `schema.sql` or to a statement:

```sh
npm run smoke:d1 -w @chatwarden/corpus-service
```

## Cutting a release (the owner, every month)

The tools live in `tools/`; their logic is TypeScript compiled by `tsc`, so build once (and after any change), then run them from the repository
root. Keys are Ed25519, generated and kept by you: the Worker, CI and GitHub never hold one, and **no tool prints a key or a passphrase** (the key is
read from a file or an environment variable you name, the passphrase is typed at a prompt, never an argument; `--passphrase-env NAME` names a
variable for automation).

```sh
npx tsc -b services/corpus
```

**Keys, once** (the first release only: design owner action 3). Make two, keep the standby offline in a second place, and put the printed
public keys in `packages/matcher/src/corpus/keys.ts` in a pull request (the only edit that turns the loader on). The tool refuses a path inside a
git working tree and never overwrites a file:

```sh
node services/corpus/tools/keygen.mjs --id k1 --out <a folder outside every repository>/k1.pem
node services/corpus/tools/keygen.mjs --id k2 --out <a different place>/k2.pem
```

**The seed, once** (owner action 5). Export Moxgate's list into a folder outside the repository as `seed.json` (a list of
`{ term, languages, category, target, severity, defaultActive, source }`), the ordinary-word list of each language (one word a line, most common
first) and, if you have them, known-innocent lines. Export the database, make the SQL, read it, apply it:

```sh
npx wrangler d1 export chatwarden-corpus --remote --output <folder>/d1-export.sql
node services/corpus/tools/seed.mjs --terms <folder>/seed.json --dump <folder>/d1-export.sql --dictionary en=<folder>/en.txt --negatives en=<folder>/negative-en.txt --out <folder>/import.sql
npx wrangler d1 execute chatwarden-corpus --remote --file <folder>/import.sql
```

The seed makes every term `provisional` with one approval vote behind it and its `source` in the audit. `--dictionary` and `--negatives` each take one
`<language>=<file>`, so run the tool again, with a new `--out`, for each other language (the SQL is safe to apply twice). Without a dictionary the
gates have nothing to judge a word against, so load one before the first release.

**Each release.** Reviewers work the queue; then:

```sh
npx wrangler d1 export chatwarden-corpus --remote --output <folder>/d1-export.sql
node services/corpus/tools/release.mjs --dump <folder>/d1-export.sql --out <folder>/out --previous <folder>/last/terms-2026.11.0.zip
```

`release` reads a **copy** of the database, never the live one. It builds `terms.json`, `exceptions.json`, `negative.<lang>.json` and
`positive.json`, writes the zip, reads it back with the kit's own parser and runs the gates with the real matcher in every selection of the
languages; then it prints the diff: counts and ids, never a word (add `--show-words` to see them). A term that fails a gate is held out with a
code; one that was already published and now fails stops the build (dispute it first). More than 200 new terms need `--allow-bulk` (the first
release). The eval set is built the same way, from a folder of `cases.<lang>.json`; `eval check` runs the privacy rules on one case:

```sh
node services/corpus/tools/eval.mjs build --cases <folder>/cases --dump <folder>/d1-export.sql --out <folder>/out
node services/corpus/tools/eval.mjs check --case <folder>/one-case.json --source <folder>/the-original.json --dump <folder>/d1-export.sql
```

Read the diff. Then sign the zip, archive it on Zenodo (the first record is made by hand; after that the tool makes a new version and prints
the record id to use next time), and publish (the index is signed here too, and uploaded last):

```sh
node services/corpus/tools/sign.mjs --kind zip --file <folder>/out/terms-2026.12.0.zip --key-id k1 --key <folder>/k1.pem
node services/corpus/tools/zenodo.mjs --release <folder>/out/terms-2026.12.0.release.json --record <deposition id of the latest version> --key k1=<public key>
node services/corpus/tools/publish.mjs --release <folder>/out/terms-2026.12.0.release.json --key-id k1 --key <folder>/k1.pem --mirror <folder>/out/zenodo-terms-2026.12.0.json --dry-run --out <folder>/dry
node services/corpus/tools/publish.mjs --release <folder>/out/terms-2026.12.0.release.json --key-id k1 --key <folder>/k1.pem --mirror <folder>/out/zenodo-terms-2026.12.0.json
npx wrangler d1 execute chatwarden-corpus --remote --file <folder>/out/record-terms-2026.12.0.sql
node services/corpus/tools/verify-live.mjs --key k1=<public key>
```

`ZENODO_TOKEN` is read from the environment of the release machine (the name can be changed with `--token-env`), and the Zenodo step may be left
out: a release without a mirror is valid, and a later publish adds it (give `publish` the same release and `--mirror` again). `--dry-run` signs and
writes the new index to `--out` and uploads nothing: do it first. `publish` reads the live index and refuses to build on one that does not verify,
never lowers the sequence, uploads the zip and its signature, reads them back and verifies them, and only then replaces the index signature and the
index as a pair (the old pair is put back if that fails). The SQL it writes records the release in the database (`since` for the new terms, the
release row); you apply it once. After a Zenodo upload, `UPDATE releases SET doi = '...' WHERE kind = 'terms' AND version = '...'` records the DOI
(the result file has it). **`verify-live` is the last step**: it fetches the public urls and verifies them end to end with the kit's own loader. If
it fails, do not announce the release. After a key rotation, name the older key that `publish` must still trust with `--trust k1=<public key>`.

## Checks

```sh
npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts
npx vitest run services/corpus/test/build-release.test.ts services/corpus/test/build-gates.test.ts services/corpus/test/build-diff.test.ts
npx vitest run services/corpus/test/sign.test.ts services/corpus/test/publish.test.ts services/corpus/test/zenodo.test.ts
npx vitest run services/corpus/test/eval-build.test.ts services/corpus/test/checkcase.test.ts
npx vitest run scripts/readme.test.ts scripts/no-corpus-data.test.ts
```
