# @chatwarden/corpus-service

The service behind the shared term list (design `docs/design/2026-11-12-k7-term-corpus.md`): it takes one-term submissions and reports,
holds the review queue and the term database, and builds the releases the maintainer signs. It is a **private workspace**: it is never
published to npm, never in a release run, and nothing in it deploys by itself.

Everything here runs in tests with no Cloudflare account. D1, R2 and Cloudflare Access sit behind small interfaces (`src/env.ts`); the
tests use a D1-shaped adapter over `node:sqlite` (`test/d1.ts`) and a Map-backed bucket (`test/r2.ts`). The code holds **no term, no list and
no key**: tests use invented words and keys generated at run time, and `scripts/no-corpus-data.mjs` guards the repo. The real lists, the seed
and the dictionary live outside the repository (the design's `.corpus-data/`), and the tools below refuse to write them inside a git tree.

The tools and the tests need **Node 24 or later** (they use `node:sqlite`, which Node 22 does not fully have). The Worker itself runs on
Cloudflare, not Node. On an older Node the repo's test run leaves the service's tests out.

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
days, notes 90 days after a decision, the installation hash of a decided submission after 180, and the channel key of a report (the same hashes)
after two days (network) or 180 days (installation) from the report's day, when it becomes `gone:<its id>`.

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
git working tree and never overwrites a file. On Windows the file mode is not enforced, so put the key in a folder only your account can read, and make
the second copy of `k2` offline (a USB stick in a drawer), never in a synced folder:

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

The release folder holds the whole real list, so `release`, `eval build` and `publish --dry-run` write to `chatwarden-release-out` in your home
folder unless `--out` says otherwise, and **refuse a folder inside a git working tree** (the one exception is `release-out/` or `.corpus-data/` at the
top of a repository, which git ignores; the repository guard fails if a file there is ever tracked).

`release` reads a **copy** of the database, never the live one. It builds `terms.json`, `exceptions.json`, `negative.<lang>.json` and
`positive.json`, writes the zip, reads it back with the kit's own parser and runs the gates with the real matcher in every selection of the
languages; then it prints the diff: counts and ids, never a word (add `--show-words` to see them). A term that fails a gate is held out with a
code; one that was already published and now fails stops the build (dispute it first). More than 200 new terms need `--allow-bulk` (the first
release). The eval set is built the same way, from a folder of `cases.<lang>.json`; `eval check` runs the privacy rules on one case:

```sh
node services/corpus/tools/eval.mjs build --cases <folder>/cases --dump <folder>/d1-export.sql --out <folder>/out
node services/corpus/tools/eval.mjs check --case <folder>/one-case.json --source <folder>/the-original.json --dump <folder>/d1-export.sql
```

Read the diff. Then sign the zip, rehearse the Zenodo step on its sandbox, check the publish with a dry run, and only then do the permanent steps (the
first record is made by hand; after that the tool makes a new version and prints the record id to use next time). The index is signed by `publish`
and uploaded last:

```sh
node services/corpus/tools/sign.mjs --kind zip --file <folder>/out/terms-2026.12.0.zip --key-id k1 --key <folder>/k1.pem
node services/corpus/tools/publish.mjs --release <folder>/out/terms-2026.12.0.release.json --key-id k1 --key <folder>/k1.pem --dry-run --out <folder>/dry
node services/corpus/tools/zenodo.mjs --sandbox --release <folder>/out/terms-2026.12.0.release.json --record <sandbox deposition id> --key k1=<public key>
node services/corpus/tools/zenodo.mjs --release <folder>/out/terms-2026.12.0.release.json --record <deposition id of the latest version> --key k1=<public key>
node services/corpus/tools/publish.mjs --release <folder>/out/terms-2026.12.0.release.json --key-id k1 --key <folder>/k1.pem --mirror <folder>/out/zenodo-terms-2026.12.0.json
npx wrangler d1 execute chatwarden-corpus --remote --file <folder>/out/record-terms-2026.12.0.sql
npx wrangler d1 execute chatwarden-corpus --remote --file <folder>/out/doi-terms-2026.12.0.sql
node services/corpus/tools/verify-live.mjs --key k1=<public key>
```

`ZENODO_TOKEN` is read from the environment of the release machine (the name can be changed with `--token-env`), and the Zenodo step may be left
out: a release without a mirror is valid, and a later publish adds it (give `publish` the same release and `--mirror` again). **`zenodo --sandbox`**
uses sandbox.zenodo.org (it needs a sandbox token and a sandbox record, in the same environment variable) and writes its own result file,
`zenodo-sandbox-terms-2026.12.0.json`, so it never stands in for the real archive; `publish --mirror` refuses a sandbox result, a sandbox DOI or any
host but zenodo.org, because a mirror in a signed index is permanent in practice. `--dry-run` signs and
writes the new index to `--out` and uploads nothing: do it first. `publish` reads the live index and refuses to build on one that does not verify,
never lowers the sequence, uploads the zip and its signature, reads them back and verifies them, and only then replaces the index signature and the
index as a pair (the old pair is put back if that fails, and if even that fails it says so and exits non-zero: restore `index.json` and
`index.json.sig` by hand). The SQL it writes records the release in the database (`since` for the new terms, the
release row); you apply it once. `zenodo` writes the SQL that records the DOI beside its result file (`doi-terms-2026.12.0.sql`); apply it too.
The signature and the index are two objects, so for a moment a fresh client can see one new and one old and fail closed: run `verify-live` a minute
after the upload. **`verify-live` is the last step**: it fetches the public urls and verifies them end to end with the kit's own loader. If
it fails, do not announce the release. After a key rotation, name the older key that `publish` must still trust with `--trust k1=<public key>`.

### The index expires after 90 days

Every `publish` signs the index with an expiry 90 days ahead. After that, kits answer `index_expired` to a **new** installation (kits that already
have a release keep running on it). A month with no release still needs a fresh index: re-sign the live one, with no release file, at least every
60 days:

```sh
node services/corpus/tools/publish.mjs --refresh --key-id k1 --key <folder>/k1.pem
node services/corpus/tools/verify-live.mjs --key k1=<public key>
```

`--refresh` takes the next sequence and a new expiry and leaves the releases as they are (`--dry-run` first, if you like). Put it in your calendar.

### Rotation and compromise

**Rotating** (a planned change of key): sign the next release with the standby `k2` after adding its public key to `packages/matcher/src/corpus/keys.ts`
in a release of the kit, naming the older key with `--trust k1=<public key>` so `publish` can verify the index `k1` signed.

**If a key may be compromised** (the procedure is signed by the standby, so it needs no new kit):

1. Sign an index with `k2` that revokes `k1` (and any release `k1` signed that you no longer vouch for, with the reason `key_compromise`):

   ```sh
   node services/corpus/tools/publish.mjs --key-id k2 --key <folder>/k2.pem --trust k1=<public key of k1> --revoke-key k1 --revoke-release terms:2026.12.0:key_compromise
   ```

2. Run `verify-live`. Kits that fetch the new index stop trusting `k1` at once; installations that still hold a release keep it until they refresh.
3. Cut a new release signed by `k2`, make a new standby `k3`, and ship a kit that lists it in `keys.ts`.

To withdraw one release without a key problem: `publish --revoke-release terms:2026.12.0:bad_release` (the reasons are `bad_release`,
`key_compromise` and legal; the index signed by the key you use cannot revoke that key itself). Re-publishing a live release with a revocation
is a real publish, not "nothing to publish".

## Checks

```sh
npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts
npx vitest run services/corpus/test/build-release.test.ts services/corpus/test/build-gates.test.ts services/corpus/test/build-diff.test.ts
npx vitest run services/corpus/test/sign.test.ts services/corpus/test/publish.test.ts services/corpus/test/zenodo.test.ts
npx vitest run services/corpus/test/eval-build.test.ts services/corpus/test/checkcase.test.ts
npx vitest run scripts/readme.test.ts scripts/no-corpus-data.test.ts
```
