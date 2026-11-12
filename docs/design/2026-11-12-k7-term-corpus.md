---
status: draft, awaiting controller rulings (section 22)
updated: 2026-11-12
release: assigned in merge order (kit work), plus a separate corpus service that deploys on its own
---

# K7: the shared term corpus, and published calibration and eval sets

The matcher (`@chatwarden/matcher`) ships with no terms, on purpose. An adopter brings a list: today that means building a `TermPack`
by hand from their own moderators' terms, or running on the invented words in `@chatwarden/matcher/fixtures`. This note adds the
missing half. A **shared, community-maintained term corpus** (slurs and abusive terms, per language, each with the lines it must block
and the lines it must never block) is published as **signed, versioned releases** from a small service the owner runs, mirrored to
Zenodo, and loaded by the kit through an **opt-in, server-only loader** that verifies the signature, caches on disk and feeds the
live term list. The hub gains a per-term **"Share with the community list"** action behind its existing term editor. **Calibration and
eval sets** (moderation cases in the AI eval's format) are published the same way.

It builds on `docs/design/2026-11-09-product-scope.md` section 9 ("Shared slur list on our own corpus service, signed zipped releases,
Zenodo mirror, 'Share with the community list' button" and "Calibration and eval sets published the same way") and on the "Where the
terms themselves live" section of `docs/design/2026-11-09-chatwarden-design.md`, whose owner decision (2026-11-09: not GitHub, no asking
GitHub for exceptions) this note keeps. The research note that design cites (`docs/research/2026-11-09-community-term-corpus.md`) is not
in this repository; its decisions are restated here where they bind (statuses, two approvals, the cross-language negative gate, the
in-group term that stays off by default).

**Content rule for this note and everything built from it.** No real slur, hateful term or abusive phrase appears in this repository:
not in docs, tests, fixtures, examples, commit messages or the plan. Every example uses the invented words `zorbak`, `vlemmo`,
`quissel`, `drakkuun`, `fenrisk`, `tarvo`, `snerp`, `glarn`. The real corpus lives on the service and on the maintainers' machines,
never in git. A repo test enforces it (section 18).

## 1. Why

**The kit is half useful without a list.** `README.md` says "Always pass a term pack (a slur `matcher`)". Every adopter must therefore
find, vet and maintain a list of words they would rather not type. Most small studios cannot do that well: the list is wrong in both
directions (a place name blocked, a slur missed), nobody checks it against innocent text in other languages, and each studio repeats
the work. The product scope's test for "complete" is that a studio with no trust-and-safety staff gets what a funded team would
build. A vetted shared list is the largest remaining piece of that.

**The matcher already has the machinery to use one.** `TermPack` (`packages/matcher/src/termPack.ts`) is the shape: terms with
`positive` and `negative` example lines, exceptions, a `negativeCorpus`, `knownLosses` and an optional `positiveCorpus`.
`loadTermPack` validates untrusted JSON, and its doc comment says "Fetching a pack and checking its signature happen elsewhere (K7)".
`LiveTerms` seeds a store from a pack once per pack id and then lets moderators edit, with a dry run ("would have blocked these 3 lines")
and a canary that refuses an exception that would unblock a required line. K7 is the "elsewhere".

**The precision-first promise needs the lines.** A list of words alone is how innocent text gets blocked (the Scunthorpe problem, and a
word that is a slur in one language and a plain word in another). The corpus design makes every term carry evidence: lines it must block
and lines it must never block, checked by CI-style gates on every release, across languages. Nobody can do that per studio.

**It must not repeat 0.1.3.** `@chatwarden/matcher` once shipped obscenity's English word list, real slurs included, into every browser
bundle, because a CommonJS dependency had no `sideEffects` flag and a bundler kept its data (issue #8, fixed in 0.1.3; see
`docs/plans/follow-ups.md`). The lesson is structural: **term data must not be reachable through any import graph a browser build
follows, and must not sit in any npm tarball.** Section 16 turns that into rules and tests.

## 2. Goals and non-goals

### Goals
- A vetted, community-maintained list in **en, es and pt**, each term with status, category, severity, target group, and its evidence lines.
- Published as **signed releases**; verification works in Node and in a browser with **no native dependency**.
- An **opt-in, server-only loader** in the kit: fetch, verify, cache on disk, feed `LiveTerms`; offline-first; pinnable; **fail-closed**
  (a release that does not verify is ignored and the last good list stays).
- The adopter's own edits always win over the community list. Nothing the community does can switch on a term the adopter turned off.
- A **"Share with the community list"** action in the hub: staff opt-in, per term, no chat text, no identifiers.
- A **review queue** for maintainers, abuse controls, a licence and consent text, and a way to remove or dispute a term.
- A **Zenodo mirror** so the data outlives the service.
- **Calibration and eval sets**, aligned with the AI eval's case format, published the same way.
- **Free or near-free** to run. No new npm package, no store migration.

### Non-goals
- No term data in the repository, in any npm package, in any browser bundle, or in the default install.
- No phrases. The matcher reads single words of plain letters (`normaliseTerm` in `matcher.ts`), so the corpus holds words, plus
  exceptions (phrases that cancel a match).
- No non-Latin scripts in this release (section 13).
- No AI-written terms or AI approval. An AI second opinion on a proposed term's innocent senses is a later aid (the design note lists it),
  never a decision.
- No hosting for adopters. The service serves the corpus and takes submissions; it is not a moderation backend.
- No automatic reactivation of anything an adopter switched off, and no remote switch that changes a game's list without that game's
  config choosing to follow (section 9).

## 3. Rulings

Each ruling states the decision, what it costs, and what was rejected. The details below follow from them.

1. **Hosting: Cloudflare, three pieces: R2 for release files, a Worker for submissions and review, D1 for the queue and the term
   database.** Reads come from an R2 bucket on a custom domain (`releases.chatwarden.dev`, static, cacheable, no code on the read path);
   writes go to a Worker on `corpus.chatwarden.dev`. *Trade-off:* it depends on one vendor's free tiers and acceptable-use terms
   (mitigated by the signed, portable format, the Zenodo mirror and `mirrors` in the index: a move is a base-URL change, section 5).
   *Rejected:* GitHub Releases on a private-content repo (section 5.2: cannot serve anonymous downloads, cannot take a button's
   submissions, and puts the owner's account at risk for content the owner already decided not to put on GitHub); a public repo of any
   kind (the owner's 2026-11-09 decision); npm data packages (the 0.1.3 failure); a VPS (a cost and an ops burden for no gain).
2. **The corpus is published as two kinds of release, `terms` and `eval`, under one index.** Each release is a **zip** plus a **detached
   signature**; the index (a small JSON file listing releases) is itself signed. *Trade-off:* a second file format to read (a zip) instead
   of plain JSON. Worth it because the zip is the unit that is signed, mirrored to Zenodo, downloaded by hand and archived.
3. **Signature: Ed25519 over the raw bytes, with a domain-separating prefix, verified with WebCrypto (`crypto.subtle`).** No dependency, no
   native code, the same call in Node 22.13+ and in browsers that support `Ed25519` in WebCrypto. *Trade-off:* a browser without Ed25519
   support cannot verify (the loader is server-side by default, so this affects nobody who follows the docs). *Rejected:* PGP/GPG
   (tooling and key handling are worse, not WebCrypto), minisign/signify (same curve but no WebCrypto parser to reuse, and one more
   format), Sigstore keyless (needs the network and a transparency log at verify time, which breaks offline-first).
4. **Key custody: the owner holds the signing key offline; the Worker, CI and GitHub never hold it.** Two keys are generated on day one
   (`k1` active, `k2` standby) and both public keys ship inside `@chatwarden/matcher`. A release is cut and signed on the owner's
   machine after a human reads the diff. *Trade-off:* releases need the owner (a bus factor of one for signing; the standby key can be
   given to a second maintainer). *What it buys:* a compromised Worker, D1 or Cloudflare account can poison the review queue but
   **cannot ship a list to anyone**. Section 7.
5. **Consumption is an opt-in, server-only subpath of `@chatwarden/matcher`, not a new package.** `@chatwarden/matcher/corpus` is
   isomorphic (no `node:` import: verify, parse, map to a `TermPack`, fetch through an injected `fetch`, cache through an injected
   interface). `@chatwarden/matcher/corpus/node` is the only place with `node:fs` (a disk cache and a convenience starter). *Trade-off:*
   `packages/matcher/src` is under the browser-safe lint ban today, so one folder gets a narrow, tested exemption. *Rejected:* a new
   package `@chatwarden/corpus` (clean, but the 11th package needs a hand-made first publish before OIDC works, edits to every "ten
   packages" sentence, `publish-order`, `manifests` and `release-workflow` tests; the subpath gets the same opt-in with none of that).
   Revisit if the loader grows past the matcher's remit.
6. **Offline-first, with no term data in any npm package.** The "bundled minimal default" is **a cache directory and an optional seed**,
   not shipped words: an adopter bakes a verified release into their image (`seed: { zip, sig }`) or lets the first online start fill
   the cache. With no cache, no seed and no network, the loader reports `none` and the kit keeps whatever the adopter's own pack and
   edits provide (the existing fail-open posture of `LiveTerms`). *Trade-off:* a fresh install that is offline on its first start has no
   community list until it has been online once or been given a seed. *Rejected:* a minimal real default inside the npm package: it is
   exactly the 0.1.3 failure (data in a tarball that CDNs mirror and bundlers can reach), and the design's anti-goal "shipping slur data
   in the default install".
7. **Pin or follow, chosen explicitly, never defaulted.** `pin: '2026.12.0'` loads exactly that release and never changes. `follow:
   'stable'` loads the newest signed release on the index. The type requires one of them. Applying a newer list to a running store is
   `apply: 'manual'` (default; the hub shows the change and an owner applies it) or `'auto'`. *Trade-off:* one more decision at setup.
   *Why:* the scope doc says "pinned in the adopter's config; updates are opt-in", and a silent change to what a game blocks is a
   moderation decision someone should own.
8. **Fail-closed means: nothing unverified is ever used, and moderation continues on the last good list.** Any failure from index to
   validation keeps the previously applied list, logs a stage and a code (never a term), and is visible in the hub. A bad download can
   never make a game's filter weaker or empty. Section 9.
9. **The adopter's edits win.** Corpus rows carry `addedBy: 'corpus:<version>'` in the existing store columns (no migration). A sync
   changes only rows no human has touched (`updatedBy` still null). A toggled, renamed or re-noted row is left alone and counted as
   "kept yours". A term an adopter switched off stays off through every release.
10. **Untouched community rows are not listed to the hub's browser.** `GET /terms` keeps listing the adopter's own and touched rows; the
    untouched community rows are summarised (counts) and reachable one at a time (by id from a blocked line or the tester, or by exact
    word lookup). *Trade-off:* a moderator cannot scroll the whole community list in the hub. *Why:* it is the 0.1.3 principle applied to
    the staff API: no bulk term data reaches a browser by default. An adopter who wants the browse view sets `exposeCommunityRows`.
11. **Contributions are one term at a time, from a person, with no chat text and no identifier.** The hub sends the word, language,
    category, optional target and a short note, through the adopter's own server (the browser never talks to the corpus service), signed
    with a random per-installation key that identifies nobody. Section 10.
12. **Review is two humans, one fluent, in a small Cloudflare-Access-protected page; the kit's hub is not the review UI in K7.**
    *Trade-off:* it forgoes the "dogfood the hub" idea of the design note. *Why:* the hub is built around reports and sanctions;
    making it a corpus reviewer is a project of its own (section 22, question 4).
13. **Licence: CC BY 4.0 for the corpus and the eval sets** (the scope doc's choice). Contributors license their submission under it.
    Code stays Apache-2.0. *Trade-off:* adopters must attribute (one sentence in their docs); *rejected:* ODbL (share-alike on any
    blended list makes adopters' own lists subject to it), CC0 (no attribution, but no way to keep the project credited and
    contributors told that their work stays attributed).
14. **Zenodo is an archive, scripted per stable release after the first, manual one.** The index lists the DOI and a file URL as a mirror;
    because the signature covers the bytes, a mirror needs no trust. Section 11.
15. **Calibration and eval sets are one file shape: the AI eval's `EvalCase`**, plus an optional `meta` object. Synthetic cases may live
    in the repo; cases with real terms or contributed material live only in the published sets. Contributed cases are paraphrased by a
    reviewer so the original wording is gone. Section 12.
16. **No store migration, and one small core addition.** `AUDIT_ACTIONS` gains `term.share` and `community.apply`, and
    `AUDIT_TARGET_TYPES` gains `release`. `http` and `hub-react` raise their core peer floor by hand in release prep. The
    SQLite audit filter is built from `AUDIT_ACTIONS`, so there is no migration.

## 4. Architecture

```
 maintainers' machine (offline key)                 Cloudflare (owner's account)                       adopter
 ──────────────────────────────────                ────────────────────────────                       ───────
                                                    Worker  corpus.chatwarden.dev                      game server
  corpus:release  ── builds + gates ──┐               POST /v1/submissions   <── signed (install key) ── hub "Share"
   (reads accepted rows from D1)      │               GET  /v1/submissions/:id                            via /admin/terms/:id/share
  sign (Ed25519, offline) ────────────┤               POST /v1/reports  (removal/dispute)
  corpus:publish ── upload ───────────┼──────────►   /admin/*  (Cloudflare Access): review queue
  corpus:zenodo  ── archive ──────────┘               D1: terms, submissions, reviews, audit
                                                      R2: releases bucket ──► releases.chatwarden.dev   <── fetch ── @chatwarden/matcher/corpus
                                                          v1/index.json(+.sig)                               verify (WebCrypto) → disk cache
                                                          v1/terms/<ver>/terms-<ver>.zip(+.sig)              → LiveTerms.syncPack
                                                          v1/eval/<ver>/eval-<ver>.zip(+.sig)
                                       Zenodo  DOI per release (mirror, fallback download)
```

**Trust boundaries.**
- The **adopter trusts the keys inside the npm package** (published with provenance). Nothing on the network is trusted until its
  signature verifies against those keys.
- The **Worker/D1/R2 are untrusted for integrity.** They hold the queue and serve bytes; they hold no signing key. R2 holds only things
  that were signed offline.
- The **release machine** is the only place the private key is used, after the builder has re-run every gate against the real matcher.
- **Reviewers** are trusted for judgement, not for publishing: their approvals are inputs to a release the owner still reads and signs.

**Three roles in the kit repo** (all code, no data): `packages/matcher/src/corpus/` (consumer), `services/corpus/` (a private workspace:
the Worker, the D1 schema, the gates, the release/sign/publish/Zenodo tools; section 6.9), and the hub/http additions (sections 8 and
14).

## 5. Hosting and cost

### 5.1 The comparison

| | Cloudflare R2 + Worker + D1 (chosen) | GitHub Releases on a private-content repo |
| --- | --- | --- |
| Anonymous download by the kit | Yes: public R2 domain, no token | **No.** Release assets of a private repo need a token; a token inside an npm package is a leak. A public repo is the owner's rejected option |
| The "Share" button | A Worker endpoint takes it | Needs a bot token and the API, or opens issues/PRs with the term in them: the content is then on GitHub anyway |
| Content policy risk | Cloudflare's terms (verify, below); the data is moderation data, mirrored on Zenodo | GitHub's acceptable-use terms prohibit hateful content and a private repo is still in scope; enforcement can suspend the **account that also owns the public code repo** |
| Review workflow | Own page behind Access | Pull requests are good here (the one real advantage) |
| Signed, portable format | Same | Same |
| Cost | $0 on free tiers at this scale (5.3) | $0 |
| Survives if the vendor says no | Yes: move the bucket, keep the keys, the index lists mirrors | The project's other repo is at risk with it |

**Recommendation: Cloudflare.** The decisive facts are that the kit must download without a credential and the button needs an
endpoint; the second is that the owner has already ruled the terms off GitHub. The one thing GitHub does better (review by pull
request) is not worth putting the main repository's account at risk. The owner's Cloudflare account already hosts the site (Pages), so
nothing new is trusted. **Owner to verify before launch:** Cloudflare's acceptable-use terms for hosting a list of offensive words with
a clear moderation purpose, and a one-line note in the repository that the project will move if the answer is no.

### 5.2 Why not the alternatives
- **npm data package:** is the 0.1.3 failure (a tarball CDNs mirror and bundlers can reach).
- **Hugging Face / Codeberg:** prohibit the content (design note, 2026-11-09).
- **A VPS or Fly.io:** a monthly cost and an ops burden; static files and a tiny Worker do not need a server.

### 5.3 Cost
All three products have free tiers well above this project's load. Rough budget, to confirm in the dashboard on setup:
- **R2:** a few MB of zips; the free allowance is 10 GB-month of storage and millions of operations a month, with no egress fee. The index
  is fetched once a day per following install.
- **Workers:** the free plan allows 100 000 requests a day; submissions and review are a few hundred a day at the very most. Reads never
  touch the Worker (they come from the R2 domain), so download volume cannot exhaust it.
- **D1:** the free allowance (5 GB, millions of row reads a day) is far above a term table of a few thousand rows.
- **Access (reviewer login):** free for a small team; **R2 may ask for a card on file** even on the free tier. Set a billing alert at
  $1 so a surprise is an email, not a bill. Expected spend: $0.
- **Domain:** `chatwarden.dev` is already the owner's; two subdomains cost nothing.

## 6. Formats

All JSON is UTF-8, no BOM, keys as written. Every file carries a `schema` string with a version suffix; a reader rejects an unknown
major. **Examples use invented words and made-up numbers.**

### 6.1 Release layout on R2

```
v1/index.json                              (cache: 5 minutes)
v1/index.json.sig
v1/terms/2026.12.0/terms-2026.12.0.zip     (cache: immutable)
v1/terms/2026.12.0/terms-2026.12.0.zip.sig
v1/eval/2026.12.0/eval-2026.12.0.zip
v1/eval/2026.12.0/eval-2026.12.0.zip.sig
robots.txt                                 (Disallow: /)
```
Files are served with `x-robots-tag: noindex, nofollow`, `content-type: application/zip` (or `application/json` for the index),
`content-disposition: attachment` on zips and `x-content-type-options: nosniff`. Versions are **CalVer `YYYY.MM.PATCH`**; a patch is an
emergency re-release (section 10.6). Files under a version never change once published; only `index.json` moves, and it is uploaded last.

### 6.2 `index.json` (signed)

```json
{
  "schema": "chatwarden-corpus-index/1",
  "sequence": 14,
  "issuedAt": "2026-12-01T00:00:00Z",
  "expiresAt": "2027-03-01T00:00:00Z",
  "keyId": "k1",
  "revokedKeyIds": [],
  "revokedReleases": [{ "kind": "terms", "version": "2026.11.0", "reason": "bad_release" }],
  "latest": { "terms": "2026.12.0", "eval": "2026.12.0" },
  "releases": [
    {
      "kind": "terms",
      "version": "2026.12.0",
      "publishedAt": "2026-12-01T00:00:00Z",
      "minKit": "0.1.7",
      "languages": { "en": { "terms": 3, "exceptions": 1 }, "es": { "terms": 2, "exceptions": 0 } },
      "bytes": 1234,
      "sha256": "<64 hex characters of the zip>",
      "zip": "terms/2026.12.0/terms-2026.12.0.zip",
      "sig": "terms/2026.12.0/terms-2026.12.0.zip.sig",
      "mirrors": [
        { "kind": "zenodo", "doi": "10.5281/zenodo.0000000", "url": "https://zenodo.org/records/0000000/files/terms-2026.12.0.zip?download=1" }
      ],
      "notes": "Plain sentences; never a term."
    }
  ]
}
```
- `sequence` rises by one on every published index; the kit remembers the highest it has accepted and refuses a lower one (rollback).
- `expiresAt` is the freshness limit (issue date plus 90 days). An expired index is refused for **updates** (a replayed old index is the
  only way to see one); an already-applied list keeps working and `status()` reports `stale`.
- `revokedKeyIds` and `revokedReleases` are honoured only when the index verifies under a key that is **not** itself revoked in the
  kit's own constants. `reason` is a closed list: `bad_release`, `key_compromise`, `legal`.
- `releases` keeps every release ever published (an append-only history), so a pinned version stays resolvable.

### 6.3 Signature files

`terms-2026.12.0.zip.sig` and `index.json.sig` are small JSON files:

```json
{ "schema": "chatwarden-corpus-sig/1", "alg": "Ed25519", "keyId": "k1", "sig": "<base64url of 64 bytes>" }
```
The signed message is **not** the bare bytes. It is `UTF8("chatwarden-corpus/1") ‖ 0x00 ‖ UTF8(kind) ‖ 0x00 ‖ bytes`, where `kind` is
`index` or `zip` (and `submission` for the contribution wire, section 6.8). The verifier chooses `kind` from context, never from the
file. This domain separation means a valid signature on one artifact can never be replayed as another. Public keys are raw 32-byte
Ed25519 keys, base64url, imported with `crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify'])`.

### 6.4 The zip

One flat zip, entries stored or deflated, **ZipCrypto with the public password `chatwarden-terms`** (printed in the docs and in a
constant in the kit). It is **scanner hygiene, not secrecy**: it keeps antivirus engines, search indexers and casual browsing from
seeing raw words, as the security-research convention for malware samples does, while anyone can open it. Reader limits (a hostile zip is
parsed only after its signature verified, but the limits hold anyway): at most 32 entries, names matching `^[A-Za-z0-9._-]{1,64}$` (no
`/`, no `..`), at most 8 MiB compressed and 32 MiB expanded in total, no zip64, no data descriptors relied on, CRC-32 checked.

| Entry | Content |
| --- | --- |
| `manifest.json` | what is in this release (6.5) |
| `terms.json` | the term rows (6.6) |
| `exceptions.json` | the exception rows |
| `negative.<lang>.json` | known-innocent lines and known losses for a language (6.7) |
| `positive.json` | pack-wide lines that must keep blocking (optional) |
| `LICENSE.txt`, `README.txt` | CC BY 4.0 text, attribution sentence, the content warning, the verification steps |

### 6.5 `manifest.json`

```json
{
  "schema": "chatwarden-corpus-manifest/1",
  "kind": "terms",
  "version": "2026.12.0",
  "sequence": 14,
  "builtAt": "2026-12-01T00:00:00Z",
  "previous": "2026.11.0",
  "license": { "spdx": "CC-BY-4.0", "attribution": "Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0." },
  "languages": ["en", "es", "pt"],
  "counts": {
    "terms": { "en": 3, "es": 2, "pt": 0 },
    "exceptions": { "en": 1, "es": 0, "pt": 0 },
    "status": { "accepted": 4, "provisional": 1, "disputed": 0, "withdrawn": 0 }
  },
  "files": { "terms.json": { "bytes": 111, "sha256": "<hex>" }, "exceptions.json": { "bytes": 22, "sha256": "<hex>" } },
  "gate": { "matcher": "0.1.7", "positiveLines": 15, "negativeLines": 40, "crossLanguageLines": 90, "passed": true }
}
```
The loader checks `kind`, `version` and `sequence` against the index entry that led to it, every `files` hash, and `gate.passed`.

### 6.6 `terms.json`

An array of rows:

```json
{
  "id": "CWT-2026-00042",
  "term": "zorbak",
  "languages": ["en"],
  "category": "slur",
  "target": "none",
  "severity": "severe",
  "status": "accepted",
  "defaultActive": true,
  "collidesWith": [],
  "since": "2026.12.0",
  "approvals": 2,
  "positive": ["you zorbak", "ZORBAK!!"],
  "negative": ["zorbakian", "szorbak"]
}
```

| Field | Values and rules |
| --- | --- |
| `id` | `CWT-<year>-<5 digits>`, OSV-style, **stable for ever, never reused**. Within the 64-character, `A-Z a-z 0-9 _ . : -` id charset the staff routes need. Never derived from the word. |
| `term` | one word of plain letters after `foldTerm` (what `normaliseTerm` accepts), at least 3 letters once repeated letters collapse; at most 40 characters as written (accents allowed; they fold) |
| `languages` | one or more of the supported tags (`en`, `es`, `pt`; `pt-BR` folds to `pt` for selection). A word is **one row for the whole corpus**: the builder dedupes by the same key `loadTermPack` uses (`collapseLikePreset(foldTerm(term))`), because the matcher reads a word once whatever the language |
| `category` | `slur` (attacks who someone is), `abuse` (insults not aimed at an identity), `sexual` (sexual harassment word), `other` |
| `target` | `none`, `ethnicity`, `religion`, `gender`, `sexuality`, `disability`, `nationality`, `other`. Required for `slur`; metadata for filters and the code of conduct, never used by the matcher |
| `severity` | the kit's `ConductLevel` names a use of the word implies: `rude`, `hostile`, `severe` (`banter` is never a term) |
| `status` | `provisional` (one approval), `accepted` (two approvals, one fluent), `disputed` (an innocent-sense or error report was confirmed), `withdrawn` (removed; kept as an inactive row so a sync can switch it off) |
| `defaultActive` | false for a word that is accepted but must start off (the in-group term the owner decided to keep off the default pack on 2026-11-08, or a word with a confirmed innocent sense). Never overridden by the loader |
| `collidesWith` | tags of other supported languages in which this spelling is an ordinary word. The loader turns the row **off** when any of those languages is also installed (the matcher does not use `language`, so a Spanish word that is plain English would otherwise block English chat) |
| `since` | the release that first carried it |
| `approvals` | number of distinct reviewer approvals (a count only; no reviewer is named) |
| `positive` | lines that must be blocked by this term (generated from templates by the builder: bare, upper case, in a sentence, glued punctuation, a look-alike spelling); reviewer additions allowed |
| `negative` | lines that must never be blocked: every dictionary word, in any supported language, that contains the term or collapses to it, plus reviewer additions |

A row is **active in a store** when `status` is `accepted` or `provisional`, `defaultActive` is true, and `collidesWith` does not meet an
installed language. `disputed` and `withdrawn` rows are loaded inactive.

### 6.7 `exceptions.json`, `negative.<lang>.json`

`exceptions.json` rows: `{ "id": "CWX-2026-00007", "phrase": "snerp glarn", "languages": ["en"], "status": "accepted" }` (the phrase an
exception suppresses, like a place name; same statuses). `negative.en.json`: `{ "schema": "chatwarden-corpus-negative/1",
"language": "en", "lines": ["…"], "knownLosses": ["…"] }`, at most 2 000 lines per language (the dry run in `LiveTerms.check` runs a
candidate against them; a larger set stays in the service's gates). Lines come from public-domain or CC-licensed sentence sources and
reviewers' own writing; each line's origin is kept in D1, not in the release.

### 6.8 The contribution wire (`POST /v1/submissions`)

Headers: `content-type: application/json`; `x-cw-key` (the installation's public key, base64url); `x-cw-sig` (base64url Ed25519 signature
over `signedMessage('submission', body)`); `x-cw-stamp` (`<bits>:<nonce>`, a hashcash stamp: SHA-256 of `body ‖ nonce` must start with
`bits` zero bits, `bits` 16, about 0.1 to 0.3 s once per share). Body, at most 2 KiB:

```json
{ "schema": "chatwarden-corpus-submission/1", "term": "zorbak", "language": "en", "category": "slur", "target": "none",
  "note": null, "day": "2026-12-02", "kit": "0.1.7" }
```
`note` is at most 200 characters, no URL, no `@`, no digits run longer than 4. `day` is a calendar day (never a time) within one day of
the server's. Nothing else is read; an unknown key is a `400`. Answers: `202 { "id": "sub_…", "status": "received" }`;
`200 { "status": "known", "termId": "CWT-…" }` (already on the list; the id is public); `200 { "status": "duplicate" }`; `400
{ "error": "invalid" | "too_large" | "unsupported_language" | "stamp" }`; `401` (signature); `429` with `retry-after`.
`GET /v1/submissions/:id` (signed the same way by the same key) returns `{ "status": "received" | "in_review" | "accepted" | "declined" |
"merged", "reason"?: "known_innocent" | "not_a_term" | "duplicate" | "needs_context" | "other" }`. The reason is a closed code; reviewers'
free text never leaves the service.

### 6.9 The service's tables (D1, SQLite dialect; `services/corpus/schema.sql`)

```sql
CREATE TABLE terms (
  id TEXT PRIMARY KEY,                       -- CWT-2026-00042
  word_key TEXT NOT NULL UNIQUE,             -- collapseLikePreset(foldTerm(term)): one row per word, any language
  term TEXT NOT NULL,
  languages TEXT NOT NULL,                   -- JSON array
  category TEXT NOT NULL, target TEXT NOT NULL, severity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional','accepted','disputed','withdrawn')),
  default_active INTEGER NOT NULL DEFAULT 1,
  collides_with TEXT NOT NULL DEFAULT '[]',
  since TEXT, approvals INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE term_lines (term_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('positive','negative')), line TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('template','dictionary','reviewer')), PRIMARY KEY (term_id, kind, line));
CREATE TABLE submissions (
  id TEXT PRIMARY KEY, installation TEXT NOT NULL,          -- sha256 of the installation public key, hex
  word_key TEXT NOT NULL, term TEXT NOT NULL, language TEXT NOT NULL, category TEXT NOT NULL, target TEXT, note TEXT,
  status TEXT NOT NULL, reason TEXT, term_id TEXT, received_day TEXT NOT NULL
);
CREATE TABLE reviews (id INTEGER PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, reviewer TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','decline','dispute','restore')), fluent INTEGER NOT NULL, at TEXT NOT NULL,
  UNIQUE (subject_kind, subject_id, reviewer));
CREATE TABLE reports (id TEXT PRIMARY KEY, term_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('innocent_sense','wrong_category','removal')),
  channel TEXT NOT NULL, status TEXT NOT NULL, received_day TEXT NOT NULL);       -- no free text is stored for a report
CREATE TABLE innocent_words (language TEXT NOT NULL, word_key TEXT NOT NULL, rank INTEGER, PRIMARY KEY (language, word_key));
CREATE TABLE negative_lines (language TEXT NOT NULL, line TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY (language, line));
CREATE TABLE counters (key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, day));   -- rate limits; purged after 2 days
CREATE TABLE releases (kind TEXT NOT NULL, version TEXT NOT NULL, sequence INTEGER NOT NULL, sha256 TEXT NOT NULL,
  key_id TEXT NOT NULL, published_at TEXT NOT NULL, doi TEXT, PRIMARY KEY (kind, version));
CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL);
```
`reviews` forbids one reviewer approving twice; a reviewer cannot review a submission from an installation they control (the review page
does not show the installation, and a reviewer's own installation keys are registered). `counters` keys are `inst:<hash>` and
`net:<hash(ip + daily salt)>`; the IP is never written, and a counter row is purged after two days.

### 6.10 Eval and calibration set (`eval-<ver>.zip`)

Entries: `manifest.json` (`kind: "eval"`, counts per language and per group, same fields as 6.5), `cases.<lang>.json`, `LICENSE.txt`,
`README.txt`. `cases.<lang>.json` is an **array of the AI eval's `EvalCase`** (`examples/ai-anthropic/eval/cases.ts` on the AI branch),
unchanged, plus one optional key:

```json
{
  "id": "rude-quissel-1",
  "group": "rude",
  "reason": "harassment",
  "note": null,
  "rules": "standard",
  "pointedAt": 2,
  "lines": [
    { "who": "reporter", "text": "that was a fair fight" },
    { "who": "reported", "text": "you play like a quissel" },
    { "who": "reporter", "text": "ok" }
  ],
  "expect": { "severity": "rude", "rule": 2, "verdict": "noted", "mustCite": [2] },
  "meta": { "language": "en", "source": "synthetic", "reviewed": 3, "since": "2026.12.0" }
}
```
`meta.source` is `synthetic` (written by a maintainer with invented words), `contributed` (paraphrased from a real case, section 12) or
`derived` (a variant of another case). `expect` is the **reference label** (the consensus of three maintainers), which the hub's
calibration screen hides while a moderator labels. `group` values are the eval's `CASE_GROUPS`. `expect.severity` is a `ConductLevel` or a
band of them; `verdict` is one of `upheld`, `noted`, `no_action`, `unclear`; `mustCite` and `mustNotCite` are 1-based line numbers.
A reader (`parseEvalSet`) accepts exactly these keys and ignores `meta` content it does not know.

## 7. Signature and key custody

**Who holds what.**
- **`k1` (active) and `k2` (standby)** are Ed25519 key pairs generated on the owner's machine by `services/corpus/tools/keygen.mjs`. Each
  private key is written as an encrypted PKCS#8 PEM (`aes-256-cbc`, a passphrase the owner chooses) outside any git working tree.
  `k1` lives on the release machine; `k2` lives in a second place (an offline drive or the owner's password manager) and is the only
  copy. Both **public** keys are committed to `packages/matcher/src/corpus/keys.ts` and printed on the docs page and in each Zenodo
  record, so a person can compare a key out of band.
- **Nothing signs in CI, in the Worker or in a GitHub Action.** There is no signing secret in any environment variable of any service.
- The owner may give `k2` to one second maintainer to remove the bus factor; any signature by it is equally valid.

**Cutting and signing a release** (`services/corpus/tools/`, run by the owner): `release` (read accepted rows from D1, build the files,
run the gates with the real `@chatwarden/matcher`, print a human diff: counts, new and changed ids, never printed terms unless asked)
→ the owner reads the diff → `sign` (asks for the passphrase) → `publish` (R2 upload of the release files, then the index, last) →
`zenodo` (section 11).

**Rotation (planned, yearly or on a change of custodian).**
1. Generate a new pair `k3`. Ship its public key in a kit release (the keyring then holds `k1`, `k2`, `k3`).
2. Wait until that kit release is the oldest version in the field you care about (a few weeks).
3. Switch signing to `k2` (already trusted) or `k3`; the index's `keyId` changes; retire `k1` from `CORPUS_KEYS` in a later kit release and
   add it to `CORPUS_REVOKED_KEY_IDS`.

**Compromise.** If `k1` leaks: sign a new index with `k2` whose `revokedKeyIds` lists `k1` (kits that already trust `k2` stop trusting
`k1` at once), publish a kit patch that moves `k1` to `CORPUS_REVOKED_KEY_IDS`, rotate in a fresh standby, and re-release the latest list
under the new key. If both leak, the damage is bounded by the kit's behaviour: a release still has to pass `loadTermPack` and the
shape checks, a pinned adopter is unaffected, and the owner publishes a kit patch with new keys. **What the keyring cannot do** is
revoke a key for a kit that is already installed and offline, which is why the standby exists from day one and why `pin` is the
recommended production mode.

**Rollback and freeze.** `sequence` never goes down in the cache; `expiresAt` bounds how long an index is believed. A mirror serving an
old but valid index cannot make a kit downgrade; at worst it can withhold an update until the index expires.

## 8. The kit API

Everything is `@experimental` until 0.2 and listed so in the matcher README. Names are final unless the controller rules otherwise.

### 8.1 `@chatwarden/matcher/corpus` (isomorphic: no `node:` import, WebCrypto and an injected `fetch` only)

```ts
export type CorpusKind = 'terms' | 'eval';
export interface CorpusKey { id: string; publicKey: string }              // raw 32 bytes, base64url
export const CORPUS_KEYS: readonly CorpusKey[];                           // k1, k2; empty until the owner generates them
export const CORPUS_REVOKED_KEY_IDS: readonly string[];
export const CORPUS_BASE_URL: string;                                     // https://releases.chatwarden.dev/v1
export const CORPUS_ZIP_PASSWORD: string;                                 // 'chatwarden-terms'

export type CorpusStage = 'index' | 'download' | 'verify' | 'unpack' | 'validate' | 'cache';
export type CorpusErrorCode =
  | 'no_trusted_keys' | 'offline' | 'timeout' | 'too_large' | 'bad_index' | 'unknown_key' | 'revoked_key' | 'bad_signature'
  | 'rollback' | 'index_expired' | 'no_such_version' | 'revoked_release' | 'kit_too_old' | 'hash_mismatch'
  | 'bad_zip' | 'bad_manifest' | 'bad_pack';
export class CorpusError extends Error { readonly code: CorpusErrorCode; readonly stage: CorpusStage }   // fixed messages; never a term

// Pure steps, usable on their own (a CI job that verifies a downloaded zip by hand uses these):
export function signedMessage(kind: 'index' | 'zip' | 'submission', bytes: Uint8Array): Uint8Array;
export function verifySignature(kind: 'index' | 'zip', bytes: Uint8Array, sigFile: unknown, keys?: readonly CorpusKey[]): Promise<{ keyId: string }>;
export function readZip(bytes: Uint8Array, options?: { password?: string; limits?: Partial<ZipLimits> }): Promise<Map<string, Uint8Array>>;
export function parseTermsRelease(files: ReadonlyMap<string, Uint8Array>): TermsRelease;       // manifest + hashes + rows, strict
export function parseEvalSet(files: ReadonlyMap<string, Uint8Array>): EvalSet;
export function releaseToPack(release: TermsRelease, select: PackSelection): TermPack;          // then passed through loadTermPack

export interface PackSelection {
  languages: readonly string[];                                  // required, e.g. ['en', 'es']
  categories?: readonly ('slur' | 'abuse' | 'sexual' | 'other')[];  // default: all
  minSeverity?: 'rude' | 'hostile' | 'severe';                   // default 'hostile'
  statuses?: readonly ('accepted' | 'provisional')[];            // default both; disputed and withdrawn always load inactive
}

export interface CorpusCache {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;        // atomic: all or nothing
  remove(name: string): Promise<void>;
}

export type CorpusLoaderOptions = {
  kind?: CorpusKind;                                             // default 'terms'
  select: PackSelection;
  cache: CorpusCache;
  clock: Clock;                                                  // from core
  baseUrl?: string; mirrors?: readonly string[];
  keys?: readonly CorpusKey[];                                   // default CORPUS_KEYS
  fetch?: typeof fetch;                                          // default globalThis.fetch
  seed?: { zip: Uint8Array; sig: Uint8Array };                   // a verified release baked into an image
  apply?: 'manual' | 'auto';                                     // default 'manual'
  kit?: string;                                                  // the kit version, for `minKit`
  logger?: Logger;                                               // from core
} & ({ pin: string; follow?: never } | { follow: 'stable'; pin?: never });

export type CorpusState = 'none' | 'ready' | 'stale' | 'offline' | 'failed';
export interface CorpusStatus {
  state: CorpusState;
  applied: string | null;                                       // version in the live list
  available: string | null;                                     // newest verified version waiting
  lastCheckedAt: number | null;
  lastError: { code: CorpusErrorCode; stage: CorpusStage; at: number } | null;
  pending: SyncSummary | null;                                  // what apply() would change
}
export interface RefreshResult { status: CorpusStatus; changed: boolean }

export interface CorpusLoader {
  refresh(): Promise<RefreshResult>;          // never throws; failures land in status().lastError
  status(): CorpusStatus;
  pack(): TermPack | null;                    // the verified, selected pack, or null when nothing is verified yet
  release(): TermsRelease | null;
  /** Apply the verified pack to a live list. With apply: 'auto', refresh() calls it. */
  applyTo(terms: Pick<LiveTerms, 'syncPack'>, actor?: string): SyncResult | null;
  start(options?: { everyMs?: number; schedule?: Schedule }): () => void;   // periodic refresh; returns stop
}
export function createCorpusLoader(options: CorpusLoaderOptions): CorpusLoader;
```
`refresh()` runs off the chat path; nothing in `cw.chat.accept` ever awaits it. A throw inside it is caught and recorded.

### 8.2 `@chatwarden/matcher/corpus/node` (server only; the one folder allowed to import `node:`)

```ts
export function fileCache(dir: string): CorpusCache;            // atomic writes (tmp + rename), files 0600, dir 0700; refuses a name with a separator
export function startCorpus(options: Omit<CorpusLoaderOptions, 'cache' | 'clock'> & { dir: string; clock?: Clock }): Promise<CorpusLoader>;
//   builds fileCache(dir), runs refresh() once (bounded by 10 s), starts the periodic refresh (24 h ± 10 %, unref'd), never rejects
export function installationKey(dir: string): Promise<{ publicKey: string; sign(message: Uint8Array): Promise<string> }>;  // generated on first use
```
Cache files: `index.json`, `index.json.sig`, `releases/<kind>-<version>.zip`, `releases/<kind>-<version>.zip.sig`, `state.json`
(`{ maxSequence, applied, checkedAt }`), `installation.key` (PKCS#8, mode 0600). **The disk is untrusted:** every read of a cached release
verifies it again before use, so a tampered cache is a `bad_signature`, treated as a cache miss.

### 8.3 `LiveTerms.syncPack` (in the browser-safe matcher root; no I/O)

```ts
syncPack(pack: TermPack, options: { actor: string; dryRun?: boolean }): SyncResult;
interface SyncSummary { added: number; deactivated: number; reactivated: number; changed: number; keptYours: number; skipped: number }
type SyncResult = { ok: true; summary: SyncSummary; version: string } | { ok: false; code: ChangeRefusalCode };
```
In one transaction (the machinery of `changeSync`): for each pack term by **id**: absent in the store → add (`addedBy: actor`, e.g.
`corpus:2026.12.0`) unless another row already reads as the same word (`skipped`); present and **untouched** (`updatedBy === null`) → follow
the pack's `active` and text (`deactivated`, `reactivated`, `changed`); present and touched → leave it (`keptYours`). Exceptions the same.
Then the existing `validate()` runs (no active term would remain, rows build, no exception unblocks a `positive` line), and the pack
becomes `this.pack` so `check()` uses the new negative corpus. A refusal writes nothing. Each change writes the existing audit rows
(`term.add`, `term.toggle`, `term.update`) with the corpus actor. `dryRun` returns the summary and writes nothing. An adopter's rows are
never deleted: the store has no delete.

### 8.4 Share (server side)

```ts
// @chatwarden/matcher/corpus (isomorphic): the client of the contribution API
export interface ShareInput { term: string; language: string; category: 'slur' | 'abuse' | 'sexual' | 'other'; target?: string; note?: string | null }
export type ShareResult =
  | { ok: true; status: 'received' | 'known' | 'duplicate'; id?: string }
  | { ok: false; code: 'invalid' | 'too_large' | 'unsupported_language' | 'rate_limited' | 'offline' | 'rejected'; retryAfterMs?: number };
export interface CommunityShare {
  share(input: ShareInput): Promise<ShareResult>;
  status(id: string): Promise<{ status: 'received' | 'in_review' | 'accepted' | 'declined' | 'merged'; reason?: string } | null>;
}
export function createCommunityShare(options: {
  endpoint?: string; sign: (message: Uint8Array) => Promise<string>; publicKey: string; fetch?: typeof fetch; clock: Clock; logger?: Logger;
}): CommunityShare;
```
`createCommunityShare` is built in the adopter's server (it needs the key from `installationKey(dir)`); the hub never sees a key.

### 8.5 Staff routes (`@chatwarden/http`, built only when the adopter passes `community`)

`adminRoutes(cw, { terms, community: { loader, live, share? } })` where `community` is a structural type (http imports no matcher code):

| Route | Permission | What |
| --- | --- | --- |
| `GET /community` | `terms.read` | `{ state, applied, available, pending, lastError: { code, stage } \| null, languages, license, sharing: boolean, counts }`; no term |
| `POST /community/refresh` | `terms.write` | check now; same body as `GET` |
| `POST /community/apply` | `settings` (owner) | apply the verified pack; audit `community.apply` (target `release:<version>`); returns the summary |
| `GET /terms/:id` | `terms.read` | one row (a hidden community row too) |
| `POST /terms/lookup { word }` | `terms.read` | the row for an exact word, or `404`; the word is in the body, never the URL |
| `POST /terms/:id/share { category, target?, note? }` | `terms.write` | send one term; audit `term.share` (target `term:<id>`); answer `{ status }` only |
| `GET /terms/:id/share` | `terms.read` | `{ status, reason? }` of the last share of this term, if any |

`GET /terms` is unchanged for the adopter's own and touched rows; when `community` is present it also returns `community: { hidden: n }`
for the untouched community rows it did not list (unless `exposeCommunityRows: true`). A refused or failed share is a fixed error code,
never the service's message.

### 8.6 Core additions (the only change to `@chatwarden/core`)

`AUDIT_ACTIONS` += `'term.share'`, `'community.apply'`; `AUDIT_TARGET_TYPES` += `'release'`. Nothing else. `http` and `hub-react` raise
their `@chatwarden/core` peer floor by hand in release prep (RELEASING.md "When a peer floor must rise"), with the new names in the
changeset. `matcher` keeps `^0.1.0`: the corpus subpaths import only the `Clock` and `Logger` types.

## 9. Consumption: behaviour

**Start.** `startCorpus` opens the cache, verifies any cached release again, and applies it (`apply: 'auto'`) or leaves it pending
(`'manual'`). It then tries to refresh, bounded by 10 s, and returns; the game is not held up by the network. A failed first refresh is
`state: 'offline'` or `'failed'`, not an exception.

**Refresh.** (1) Fetch `index.json` and `.sig` (10 s timeout, 256 KiB cap, conditional request). (2) Verify under a trusted, non-revoked
key. (3) Check `schema`, `sequence` not below the stored maximum, `expiresAt` in the future. (4) Choose the release: the `pin`, or
`latest.terms`; check it exists, is not in `revokedReleases`, and `minKit` is satisfied. (5) If the verified release is already cached,
stop. (6) Download the zip from the base URL, then each mirror (60 s, 8 MiB cap). (7) Check `sha256` equals the index's, then verify
the zip's own signature. (8) Only now unzip, check the manifest and file hashes, parse, build the pack and pass it through
`loadTermPack`. (9) Write the cache (zip, sig, then `state.json` last). Any failure stops there and leaves everything before it
untouched.

**Failure table.**

| What goes wrong | Result | `status()` | The live list |
| --- | --- | --- | --- |
| No network, DNS or timeout | try mirrors, then give up | `offline`, `lastError.code` `offline` | unchanged |
| Index signature bad, unknown or revoked key | refuse the index | `failed`, `bad_signature` / `unknown_key` / `revoked_key` | unchanged |
| Index `sequence` lower than seen | refuse | `failed`, `rollback` | unchanged |
| Index expired | refuse for updates | `stale` | unchanged, keeps working |
| Pinned version not on the index, or revoked | refuse | `failed`, `no_such_version` / `revoked_release` | unchanged |
| Download hash differs from the index | refuse | `failed`, `hash_mismatch` | unchanged |
| Zip signature bad | refuse | `failed`, `bad_signature` | unchanged |
| Zip malformed, over a limit, a bad manifest or hash | refuse | `failed`, `bad_zip` / `bad_manifest` | unchanged |
| Rows fail `loadTermPack` | refuse | `failed`, `bad_pack` | unchanged |
| Cached file no longer verifies | treat as missing, re-download | `failed` until the re-download succeeds | unchanged |
| Nothing cached, no seed, offline | nothing to load | `none` | the adopter's own pack and edits |
| `syncPack` refuses (canary, no active term) | do not apply | `failed`, `bad_pack`; `pending` kept | unchanged |

Every case logs `corpus.refresh_failed` with `{ stage, code }` and nothing else (no URL query, term, line or path), through the injected
logger and the kit's `safeWarn` conventions. The hub shows the same two fields as plain words.

**Offline-first.** The disk cache is the normal source; the network only brings newer releases. The seed (`seed: { zip, sig }`) lets an
image start with a verified list before its first network call; the seed is verified exactly like a download. A game that has been offline
for months still moderates on its last good list.

**Pinning.** With `pin`, a refresh only looks for that version (and fetches it if the cache lacks it); it never moves. To change, the
adopter edits the config; the docs and `README` show `npx` free steps (the CLI is K4b; until then, a three-line script prints
`latest` from the index). With `follow: 'stable'` and `apply: 'manual'` the hub's Settings screen shows the pending summary and an owner
applies it.

**Interaction with `LiveTerms` seeding.** A `LiveTerms` is built once with `pack` (any valid pack, including the first corpus pack, which
seeds the store once per pack id as today) and the corpus loader then calls `syncPack` for every later release. Corpus rows are
`addedBy: 'corpus:<version>'`. The hub reads that prefix and says "Community list" in its existing "Changed" column.

**Performance (to be measured in plan Task 3, before limits are written down).** `buildMatcher` runs on every edit and twice on a
`changeSync` (the canary builds a terms-only matcher), and `match` runs per chat line. A real list is thousands of rows, not the dozens
the tests use. The plan benchmarks a generated 5 000-term pack of invented words and sets budgets (a rebuild under 300 ms, a line match
under 2 ms). If a budget fails, the first remedies are memoising the terms-only matcher in `validate()` and loading only `severe` and
`hostile` rows by default (already the default).

## 10. Contributions

### 10.1 The flow

1. **An adopter turns sharing on in code**: it passes `community.share` to `adminRoutes`. Without it the hub shows no Share action at
   all, and the server makes no call to the service. This is the installation's opt-in, and it needs no store change.
2. **A staff member with `terms.write`** opens a term's editor (the existing form), opens the "Share with the community list" disclosure,
   reads the exact payload and the consent text, picks a category (and a target for a slur), may add a short note, and presses Send.
   One term per send; there is no "share all".
3. **The adopter's server** builds the submission (6.8), signs it with the installation key, adds the hashcash stamp and posts it. It
   writes the `term.share` audit row (actor, role, term id; never the word). The browser never contacts the service.
4. **The service gates it on arrival** (cheap checks only): schema, size, supported language, plain-letters word, the note rules,
   signature, stamp, day window, rate limits, `word_key` already a term (`known`) or already pending (`duplicate`), and
   `innocent_words`: a word in a language's top-ranked ordinary words is auto-declined `known_innocent` unless a reviewer overrides it
   (the guard against someone submitting a common word to get it blocked everywhere).
5. **Reviewers** (section 10.3) approve or decline in the review page. One approval creates the term `provisional`; a second, by a
   different reviewer where at least one is fluent in the term's language, makes it `accepted`. The builder fills `positive` and
   `negative` lines and runs the cross-language gate; a term that fails it is held with a gate code, not published.
6. **A monthly release** (or an emergency patch) includes it. The hub's share status then reads "On the community list".

### 10.2 What is sent, and what never is

Sent: the word, its language tag, a category, a target (slurs), an optional note, a calendar day, the kit version, the installation's
**public key**. Never sent: any chat line, report excerpt, player name, subject, seat, client key, account id, game or room id, the
adopter's name or URL, a timestamp finer than a day, or the `hits` of a dry run. The share action does not read from the evidence
buffer, the audit log or `check()` results. The hub never prefills the note from a report. The installation key is random, generated
locally, and identifies a server process's file, not a person or a game; deleting the file makes a new installation. The service
sees the request's network address while it answers; it keeps only a salted, daily-rotating hash of it in a rate-limit counter that is
deleted after two days.

### 10.3 Reviewers and the review page

`/admin/*` on the Worker sits behind Cloudflare Access (an email one-time code is enough). Reviewers are listed in a table with a
language list and a `fluent` flag per language. The page shows the queue newest first, **terms masked until revealed** (the hub's
rule), a break reminder after 20 reveals (the hub's content-exposure care), the term's category, the arrival gate results, the
dictionary hits (innocent words that contain or collapse to it), and the cross-language collisions. Actions: approve, decline (a closed
reason), dispute, restore, add a negative line. Every action writes `audit`. Rules enforced by the service, not by trust:
a reviewer cannot approve twice; the second approval must come from a different reviewer; `accepted` needs a fluent approval; a `slur`
needs a `target`; nobody reviews a submission from an installation key registered to them.

### 10.4 Abuse controls

| Attack | Control |
| --- | --- |
| Flooding with junk | per-installation 20 a day and 200 pending; per-network-hash 60 a day; the 16-bit stamp; a body cap of 2 KiB |
| Key churn to dodge limits | the network-hash limit; the stamp makes each new key's first send cost the same; an installation whose last 10 results were declined gets `429` for 7 days |
| Common word submitted to get it blocked everywhere | `innocent_words` auto-decline; the cross-language negative gate at review and at release; two approvals; the owner reads the release diff |
| Brigading removals to switch the list off | a report only opens a ticket; a reviewer confirms. An innocent-sense report that is confirmed marks `disputed` on **one** reviewer's word (precision first); restoring needs two. A slur removal needs two |
| Poisoned notes (links, doxxing, hate in prose) | the note rules at arrival (no URL, `@`, long digit runs, 200 characters); the note is shown only to reviewers; it is never published in a release; it is deleted when the submission is decided plus 90 days |
| A reviewer account taken over | Access login; two approvals; every action audited; releases are signed offline after the owner reads the diff, so the worst case is a poisoned queue |
| Copying from a list with an incompatible licence | the consent text asks the contributor to confirm the word is theirs to give; no bulk import path exists; the builder rejects a release that adds more than 200 terms in one month without an owner flag |

### 10.5 Licence and consent text

The corpus and eval sets are **CC BY 4.0** (the 4.0 licence covers database rights). Each zip carries `LICENSE.txt` and the attribution
sentence in the manifest. The hub's consent text (an English catalogue string, through `t()`; the final wording is the controller's):

> **Share this word with the community list?** We will send the word, its language, the category and note you choose, and a random
> key that identifies this server, not you or your game. We do not send chat lines, player names, ids or your game's name. A volunteer
> reviewer reads it. If it is accepted, it joins a public list under CC BY 4.0 that any game can use, and it stays in releases that
> have already been published. Our server sees your server's network address while it answers and keeps only a hashed rate-limit
> count for two days. By sending, you confirm the word is yours to share. You can ask us to remove it later.

### 10.6 Removal, dispute and appeal of a term

- **Anyone** (an adopter's staff from the hub, or a person on the docs-site form with a Cloudflare Turnstile check) can report a term as
  `innocent_sense`, `wrong_category` or `removal`. The service stores the term id, the kind and the day; **no free text**, so there is
  nothing to moderate or leak. The reporter sees an acknowledgement id only.
- A reviewer resolves it within a target of 7 days (best effort; the project has no support promise). Outcomes: `disputed` (loaded
  inactive in the next release), `withdrawn`, `restored`, or `declined` with a closed reason shown on the public status page.
- **An emergency patch release** (`YYYY.MM.1`) goes out within 48 hours (best effort) when a term is confirmed to block widely used
  innocent text (a place, a common name). Releases already published stay on the index and in Zenodo; the patch supersedes them and the
  old one may be added to `revokedReleases` with reason `bad_release`.
- **Adopters are never waiting on this.** Their own edit overrides the community row at once and for good (ruling 9).
- A **person who submitted** a term can ask for its removal like anyone else; because releases and Zenodo versions are permanent copies,
  the documents say plainly that removal stops future releases and does not recall past ones. The corpus contains words only, no
  personal data, so no erasure duty attaches to a published release.

## 11. Zenodo

**What it is for.** A permanent, versioned, DOI-bearing archive of each release, run by CERN, outside Cloudflare, so the list survives the
service, and a fallback download URL listed in the index's `mirrors`.

**What goes up.** One Zenodo record per project (a *concept DOI*), one *version* per stable release (patches included): the zip, its `.sig`,
`manifest.json` as a plain file, and a README stating the licence, the content warning, the public keys' fingerprints and how to verify.
Resource type "Dataset", licence CC-BY-4.0. The eval sets get their own concept record.

**How.** The first record is made by hand in the owner's Zenodo account (to read Zenodo's policy page and see the description render).
After that `services/corpus/tools/zenodo.mjs` uses Zenodo's REST API with a personal access token (scopes `deposit:write` and
`deposit:actions`) kept only on the release machine: create a new version, upload the files, set metadata, publish, and write the DOI
and file URL into the next index. Order: build and sign the zip → upload to Zenodo → add the mirror to the index → sign the index →
publish to R2 (index last). If Zenodo is down the release goes out without the mirror and the next one carries both.

**Cadence.** Every stable release (monthly) and every patch. Zenodo versions are cheap and permanent. **Policy check first (owner):**
read Zenodo's content and acceptable-use terms for a lexicon of offensive words with a moderation purpose; if there is doubt, ask
support in one email before the first upload; the fallback is a *restricted-access* record (still a DOI) with the public mirror
removed from the index. The signature means a mirror needs no trust either way.

## 12. Calibration and eval sets

**One shape, two uses.** The AI eval (`examples/ai-anthropic/eval`) scores a model on cases; the hub's planned calibration screen lets
moderators label the same cases and shows agreement. Both read `EvalCase` (6.10). Publishing them as `eval-<ver>` releases means a
studio can run the eval against its own prompt or model, and compare its moderators, without writing 47 cases first.

**Sources, in order.**
1. **Synthetic.** Written by maintainers with invented words. May also live in the repo (they already do in the AI branch's
   `cases.json`; none holds a real term). The published `en` set starts as those cases; `es` and `pt` are written by fluent reviewers.
2. **Contributed and anonymized.** A case from a real report, **paraphrased by a reviewer** so the original wording is gone and kept
   only in shape: who said what in what order, how severe, which rule, what the right answer is. Never published verbatim.
3. **Derived.** A variant of a case (a different language, a relaxed profile, an injection attempt added).

**Privacy rules for any case that came from real chat** (enforced by `services/corpus`'s `checkCase` before a reviewer sees it, and by
the reviewer after):
- Speakers are only `reported`, `reporter`, `other`. No handle, name, id, account, IP, time, room, game or server appears.
- No URL, email, phone number, `@mention`, invite code, street address or number longer than 4 digits.
- Paraphrase, do not copy: no line may equal a source line (the tool compares against the submitted one and refuses an equal line). A
  published case may contain a real term where the case needs one (a `severe-slur` case is useless without it); like the corpus, that
  lives only inside the signed zip and the service, never in the repository, and a term in a case must already be a corpus term (so
  a case never introduces a word the term review has not seen).
- At most 12 lines, at most 200 characters a line, no minor's personal details, no real people.
- Two maintainers label it independently; the reference `expect` is their consensus (a third breaks a tie).
- A contributor can withdraw a case before the next release; because the text is paraphrased and carries no personal data, a published
  release needs no recall.

**Not in this release:** an in-hub "Share this case" action. Cases arrive through the web form and the maintainers (section 22,
question 5), using the same `checkCase` rules, so no real report text is ever sent from a hub.

**Consumption.** `createCorpusLoader({ kind: 'eval', select: { languages: ['en'] }, … })` verifies and caches exactly like terms and
`loader.release()` returns an `EvalSet` (`{ cases: EvalCase-shaped[], manifest }`). The eval runner takes a path or a loader (a small
change on the AI branch, tracked in the plan as a follow-up, not a K7 task, because that branch is not on `main`).

## 13. Multilingual: en, es, pt first

- **Selection.** `select.languages` names the languages a game wants; a row is included when its `languages` intersect. `pt-BR` and
  `pt-PT` both select `pt` (the row's tags are the base tags).
- **Folding.** The matcher reads `[a-z]` after `foldTerm` strips accents, so Spanish (`ñ`, accents) and Portuguese (`ç`, `ã`) terms work
  today and fold to the plain letters. Two spellings that fold equal are one word; the builder dedupes by that key.
- **Cross-language collisions are the hard part.** The matcher does not use `language` to decide. A Spanish term that is an ordinary
  English word would block English chat as soon as both are installed. The builder checks every term against **every supported
  language's** `innocent_words` and `negative_lines`, records the languages in which it is ordinary in `collidesWith`, and the loader turns
  the row off when one of them is installed. A game that installs only Spanish keeps the term on.
- **Reviewers.** A term needs one approval from someone fluent in a language it lists; `es` and `pt` cannot reach `accepted` without a
  fluent reviewer, so they may ship mostly `provisional` at first (the loader includes `provisional` by default, section 22 question 3).
- **Out of scope here.** Non-Latin scripts (Cyrillic, Greek, CJK, Arabic) need matcher work (`normaliseTerm` rejects them today), and
  languages without word spaces need a different matching model. Neither is in K7; the schema's `languages` field and the manifest keep
  room for them.

## 14. Hub UI: clean core, power behind one door

The owner's rule (2026-11-11): the always-visible UI stays minimal; advanced things go behind an existing disclosure.

**Always visible: unchanged.** The Terms screen's header (Show words, Add term, Add exception), the Tester, the per-language tables. No
new button, badge or counter on it. A community row looks like any other row; its existing "Changed" cell reads "Community list 2026.12"
instead of a person (no tag).

**Door 1: the existing term editor.** In `TermForm` (Edit on a row), below the existing fields, a collapsed disclosure **"Share with the
community list"**. It appears only when the server reports `sharing: true` and the row is the adopter's own (not a community row, which
is already shared). Opened, it shows: the payload exactly as it will be sent (the word masked until the screen's Show words is on), a
category select, a target select (for `slur`), an optional note field with the 200-character limit and a warning "Do not paste chat
lines", the consent text (10.5), and one **Send** button. After sending it reads "Sent. Status: waiting for review", and later "On the
community list" or "Not added" with the closed reason in words. Keyboard and screen-reader rules follow `TermForm`.

**Door 2: Settings, a new section "Community list"** (beside Steps and ladder, Reporting; shown when `GET /community` exists, so only
adopters who wired it see it). It shows: the version in use and whether a newer one is waiting; per language, counts of terms in use
(never terms); the last check and, in words, the last problem (`offline`, `the signature did not verify`, `a newer list was refused`);
**Check now**; and, for an owner, **Apply version X** with the summary ("Add 12, switch off 2, switch on 1, your 4 changes kept") shown
before and an Undo-free confirmation. A "Find a word" box (exact match, the word never in a URL) opens that single row in the Terms
screen. No browse, no export.

**Words.** Every string through `t()`, English in the catalogue; the strings never include a term. Colour only where it means something
(red for a failed check, yellow for a stale list). Checked at desktop and 360 px, light and dark.

**Hidden community rows in practice.** The Blocked screen's "show me this term" and the Tester's "matched a term" still work: they carry
the term id and the Terms screen fetches that one row with `GET /terms/:id`. A moderator switches a wrongly blocking community term off
there (a touched row from then on) and may report it as an innocent sense from the same editor (the same disclosure, "Report a problem
with this community term").

## 15. Privacy and legal

- **What the service holds:** the term database; submissions with an installation hash (retained 180 days after the decision, then
  nulled), the note (decided plus 90 days, then deleted), the arrival day; reports as (term id, kind, day); reviewers' emails (Access) and
  audit. **It never holds:** chat text, player data, an IP address (only a salted daily hash in a counter that lives two days), or any
  free text from a report.
- **Personal data:** the installation key hash and a reviewer's email are the only personal-ish data. Both have a purpose, a retention
  and a place in the privacy page (`services/corpus/PRIVACY.md`, maintainers' draft; "not legal advice").
- **Terms of use for contributors:** the consent text above, plus a short rules page: words only, no chat, no personal information,
  CC BY 4.0, removal stops future releases only.
- **Licensing hygiene:** no copying from third-party lists; the dictionary and frequency data used for gates are internal inputs whose
  licences must permit internal use (recorded in `services/corpus/SOURCES.md`, checked before each source is loaded); they are never
  redistributed. Eval sentence sources are public domain or CC licensed.
- **Hosting terms:** Cloudflare and Zenodo content terms are an owner check before launch (sections 5.1 and 11). The data is moderation
  data with a clear purpose and a content warning on every artifact, and the format is portable.
- **Dual use:** the list is public by design (transparency is part of precision). A public list tells an evader what is blocked. The
  matcher's evasion handling does not depend on secrecy, and a game can keep its own additions private.
- **Kit privacy rules (AGENTS.md) hold unchanged.** The new staff routes return no identifier. The loader logs stage and code only.

## 16. Never shipped to browsers: what 0.1.3 teaches

The failure was data reachable through an import graph. K7 closes that on five lines:
1. **No data in any package tarball.** `files` in every manifest is an allowlist already; `scripts/check-pack.mjs` gains a check that no
   packed file ends in `.zip`, `.sig` or a `*.json` with a `chatwarden-corpus-` schema.
2. **Code unreachable from the root.** `@chatwarden/matcher`'s root entry does not import `corpus/`. The browser-bundle test bundles the
   root (and `hub-react`, `hub-element`, the site entry) and asserts the esbuild metafile has **no input under `matcher/dist/src/corpus/`**
   and no occurrence of `chatwarden-corpus`.
3. **The `node:` exemption is one folder.** `packages/matcher/src/corpus/node/` may import `node:fs`, `node:path`, `node:os`,
   `node:crypto`; nothing else under `packages/matcher/src` may. `scripts/eslint-ban.test.ts` pins both halves (the folder is allowed; a
   neighbour is still refused).
4. **The staff API does not enumerate the corpus** (ruling 10): `GET /terms` omits untouched community rows by default.
5. **The site demo and examples run on the synthetic pack.** `site/test/dist.test.ts` already scans the built page; it gains the corpus
   markers. The repo guard (section 18) fails any tracked file that looks like corpus data.

## 17. Owner actions (one-time, minimal)

Everything in the kit repo can be built and merged **before** any of these: with no keys in `CORPUS_KEYS` the loader answers
`no_trusted_keys` and the hub shows no Community list. Each action unblocks a named step.

| # | Action | Unblocks |
| --- | --- | --- |
| 1 | **Cloudflare: enable R2** on the existing account (it may ask for a card; set a $1 billing alert), and run `npx wrangler login` once on the release machine. The service tools then create the bucket, the D1 database and the Worker themselves | the service deploy |
| 2 | **DNS: attach two subdomains** of `chatwarden.dev`: `releases` to the R2 bucket (custom domain) and `corpus` to the Worker. Two clicks each; the tools print the exact names | public downloads and submissions |
| 3 | **Generate the signing keys** on the release machine with `services/corpus/tools/keygen.mjs` (`k1`, `k2`), keep the private halves offline (k2 in a second place), and give the two **public** keys to the maintainers for a pull request | every signed release |
| 4 | **Name the reviewers**: at least two English, and a fluent Spanish and Portuguese reviewer; add their emails to a Cloudflare Access policy for `corpus.chatwarden.dev/admin/*` | the review queue; `accepted` terms |
| 5 | **Export the seed** from Moxgate's production term table and audit (the owner's database) into `.corpus-data/` (git-ignored, outside the repo), as the `provisional` seed with a source per term | the first release |
| 6 | **Zenodo**: an account, one email to support if the content policy is unclear, a personal access token kept on the release machine only | the mirror and the DOI |
| 7 | **Go-ahead to publish** the kit release (the ordinary tag step in RELEASING.md; no new package, so OIDC publishing is unchanged) and to point the docs at the live URLs | adopters can use it |

Optional, later: a Cloudflare Turnstile widget for the docs-site form (the `turnstile-spin` skill sets it up), and giving `k2` to a second
maintainer.

## 18. Tests that pin it

Test-first and broad, targeted runs only, an injected `Clock`, a fake `fetch`, a fake `CorpusCache` and a **generated test key pair** (the
production keys never appear in a test). All words are invented.

**Signature and formats (`packages/matcher/test/corpus-verify.test.ts`, `corpus-formats.test.ts`)**
- `signedMessage` is `prefix ‖ 0 ‖ kind ‖ 0 ‖ bytes`; a signature for `zip` fails as `index`, and as `submission`.
- `verifySignature`: valid; one flipped bit in the bytes, the sig, or the key id; a wrong key; an unknown key id; a revoked key; an `alg`
  other than `Ed25519`; a sig of 63 or 65 bytes; non-base64url; a `null`, an array, a getter that throws. Never throws anything but
  `CorpusError`.
- Index: unknown major schema, `sequence` as a string or negative, a missing `latest`, duplicate versions, an entry with a `zip` path
  containing `..` or a scheme. Round-trip of the examples in section 6.
- Terms rows: every field's allowed and refused values; a duplicate id; two terms that fold to one word; `collidesWith` handling; a
  term of two letters; accents and fullwidth forms; `__proto__` keys; unknown keys refused.
- Manifest: a file whose hash differs, a `version` that differs from the index, `gate.passed` false.
- Messages: no `CorpusError` message contains any string from the input (a table of invented words passed through every failure path).

**Zip (`corpus-zip.test.ts`)**: stored and deflated entries, ZipCrypto with the right and a wrong password, CRC mismatch, a name with `/`
or `..`, 33 entries, an 8 MiB + 1 zip, a zip bomb (expands past 32 MiB), a truncated central directory, zip64, a data descriptor,
duplicate names. The reader never reads past the buffer.

**Loader (`corpus-loader.test.ts`, `corpus-loader-failures.test.ts`)**: one test per row of the failure table (section 9), each asserting
the live list is unchanged and `status()` and the log carry stage and code only; pin vs follow; `minKit`; a mirror used after the base
fails; a cache tampered with; first start offline with a seed and without; an interrupted write leaves the old cache; two refreshes in
parallel share one download; `start()` ticks with a fake scheduler and stops; a throwing `fetch` and a hanging `fetch` (timeout).

**`syncPack` (`livetermssync.test.ts`)**: add, follow-on change, deactivate, reactivate; a touched row (toggled, renamed, noted) is
kept; a row the adopter added is never changed; a duplicate word is skipped; an id present in two languages; `dryRun` writes nothing and
returns the same summary; a refusal (no active term, an exception that would unblock a `positive` line) writes nothing; audit rows have
the corpus actor; a second sync of the same release is a no-op; the sync after the adopter switched a term off keeps it off; rows come
back in insertion order.

**Selection (`corpus-select.test.ts`)**: languages, categories, `minSeverity` default `hostile`, statuses; `disputed` and `withdrawn`
load inactive; `collidesWith` turns a row off only when the other language is installed; `pt-BR` selects `pt`; the result passes
`loadTermPack`; the 5 000-term benchmark pack stays inside the Task 3 budgets.

**Node subpath (`corpus-node.test.ts`)**: `fileCache` atomic write (a crash between tmp and rename), names with separators refused, file
modes where the platform has them; `installationKey` is created once and reloaded; `startCorpus` never rejects and unrefs its timer.

**Share (`corpus-share.test.ts`, `packages/http/test/admin.community.test.ts`)**: the payload has exactly the allowed keys (a snapshot);
the body contains none of a seeded set of identifiers (client key, subject, seat, account, IP, room, a chat line) however the route is
called; the note rules; the stamp meets the bit count; the signature verifies with the public key sent; each service answer maps to a
`ShareResult`; routes: permissions (`terms.write`, `settings`), `GET /terms` hides untouched community rows and counts them, a touched
one is listed, `GET /terms/:id` finds a hidden row, `POST /terms/lookup` with the word in the body only, audit rows hold ids and never a
word, a failed share is a fixed code.

**Hub (`packages/hub-react/test/community.test.tsx`)**: the Share disclosure appears only with `sharing: true` and an own row; closed
by default; shows the exact payload; Send disabled until the consent is shown; the Settings section appears only when `/community`
exists; the "Changed" cell text; the words contain no term; keyboard and axe; the API lock updated.

**Service (`services/corpus/test/`)**: arrival gates (each rejection code), rate limits across days with a fake clock, the signature and
stamp checks, review rules (second approval by a different reviewer; fluent required for `accepted`; a slur needs a target), the report
flow, retention purges, the builder (templates, dictionary negatives, cross-language collisions, dedupe by word key, the 200-term guard),
the release gate runs the real matcher over a generated pack, signing round-trips with the kit's verifier, the index is uploaded last,
the Zenodo tool against a fake API. D1 is exercised through `node:sqlite` with the same DDL.

**Repo guards (`scripts/no-corpus-data.test.ts`, `scripts/browser-bundle.test.ts`, `check-pack`, `eslint-ban`)**: no tracked file has a
`chatwarden-corpus-` schema whose `term`, `phrase` or line words are outside the invented set (an **allowlist** guard, so no real list is
needed to enforce it); no tracked `*.pem`, `*.key` or encrypted key; the browser bundle excludes `matcher/…/corpus/`; the packed tarballs
carry no zip or corpus JSON; the exemption folder is the only one allowed `node:`.

**Docs (`scripts/readme.test.ts`)**: the README code blocks for the loader and sync compile.

## 19. Risks

- **Vendor risk (Cloudflare, Zenodo).** Content terms could be read against us. Mitigations: owner verification before launch, the
  portable signed format, mirrors in the index, a documented move (change the base URL, re-publish), keys that do not depend on the host.
- **A bus factor of one for signing.** `k2` can go to a second maintainer. If the owner is gone, no new release is signed; existing
  caches keep working and a pinned adopter notices nothing.
- **List size vs the matcher's speed.** Thousands of terms may make rebuilds and matches slow (section 9). Measured first; the default
  `minSeverity` already keeps `rude` words out.
- **ZipCrypto is weak and a parser is attack surface.** It is not used for secrecy, the zip is parsed only after its signature
  verifies, and limits hold regardless. A fallback exists: `encrypted: false` in the manifest and an unencrypted zip, if the reader
  proves fragile.
- **Contributions are a poisoning channel.** Two approvals, the arrival gates, the offline signature and the owner's diff are four
  layers; the residual risk is a convincing word that two reviewers miss. The adopter's edit-wins rule and `disputed` handling bound
  the harm.
- **Review volume.** A free project may not keep a queue. The service still works with no new submissions; `provisional` terms from the
  seed carry the first releases. The arrival gate declines the obvious junk without a human.
- **Cross-language collisions are not fully solvable by dictionaries.** The gate catches known words; slang and names slip through.
  Mitigation: the report path, the patch release, and the adopter override.
- **A game follows `stable` and a bad release lands.** The default is `apply: 'manual'`, the hub shows a summary, and `revokedReleases`
  stops a revoked version from being newly applied. Auto-apply is the adopter's choice.
- **A merge conflict on `AUDIT_ACTIONS`.** The appeals and flood designs also add audit names. Resolve by keeping both; the SQLite filter
  is derived from the list.
- **The `node:` exemption in a browser-safe package.** It is the sharpest edge in the design: one folder, one lint exemption, two tests.
  If it ever feels fragile, the new-package option (ruling 5) is the clean fix.
- **Time zones and clocks.** `expiresAt` and `day` use the injected `Clock`; a server with a wrong clock refuses an index as expired.
  The docs say so; `status()` reports it as `stale`, not as an attack.
- **Mis-set pin.** A pinned adopter never gets a withdrawn-term fix. The hub's Community list section shows "a newer list exists" even
  when pinned, so the choice is informed.

## 20. Not in this release

- A hub review UI for the corpus, and in-hub sharing of eval cases (question 5).
- Non-Latin scripts and languages beyond en, es, pt; per-language matching.
- A `chatwarden terms install` command (K4b's CLI); until then the README shows the three-line script.
- AI-assisted review of proposed terms.
- Automatic updates that apply without the adopter choosing `apply: 'auto'`.
- A browser build of the loader for the site demo (the code is isomorphic; the demo stays on the synthetic pack).
- The hub's moderator-calibration screen (the sets are published; the screen is its own K4 follow-up).
- Changes to `@chatwarden/profanity`'s own English list. Ordinary swearing stays its job (`category: 'abuse'` and `severity: 'rude'`
  rows exist in the format so a later release can feed it).
- Phrases, regex terms and a `severity` that changes matcher behaviour (it is metadata in this release).
- A public web page listing terms. The service shows counts, versions and statuses; the data is in the signed zips.

## 21. Rollout and docs

- **Two deliverables, two cadences.** The **kit work** is one changeset, a patch in the fixed group, merged and released in the usual
  way. The **service** (`services/corpus`) is a private workspace that is deployed by the owner with `wrangler` and is not published.
- **Changeset notes (kit):** the new subpaths `@chatwarden/matcher/corpus` and `@chatwarden/matcher/corpus/node`, `LiveTerms.syncPack`,
  the staff routes and the hub's Community list, the three core names, the two peer floors (`http` and `hub-react` on core, set by hand)
  with the names that forced them, no migration, `@experimental` until 0.2, and a plain sentence that **the package ships no terms**.
- **Docs:** the matcher README (replace "That corpus is not released yet"), the http README (community routes), the hub-react README
  (the Community list section), the root README (an "I want to" row: "Use the shared community term list"), `docs/status.md`,
  `docs/plans/follow-ups.md`, `CLAUDE.md` (the "Before you change an area" table), `AGENTS.md` (the rule gains "and no corpus data"),
  `services/corpus/README.md` (deploy, tools, the owner's steps) and a docs page for contributors (rules, consent, licence, removal).
- **Nothing is on by default.** An adopter that imports nothing new changes nothing. The Community list is absent from the hub until the
  server passes `community`.
- **The site headline and copy** change only after the first real release exists and has been used; this note changes no copy.

## 22. Open questions

Each has a recommendation; the controller rules.

1. **Licence: CC BY 4.0, ODbL or CC0.** *Recommended: CC BY 4.0* (the scope doc's choice): it covers database rights, keeps credit, and
   does not infect an adopter's own list as ODbL's share-alike would.
2. **Zenodo cadence.** *Recommended: every stable release and patch, scripted after a manual first one,* with a policy check first.
   Quarterly would reduce the count of permanent versions but delays the fallback's freshness.
3. **Defaults: `minSeverity: 'hostile'` and `statuses: ['accepted', 'provisional']`.** *Recommended: yes to both.* `rude`-level words are
   the profanity package's territory; `provisional` is needed so es and pt are usable before they have fluent second approvals, and the
   hub and README say which are which.
4. **Review UI: a small Access-protected page now, or dogfood the hub.** *Recommended: the small page now.* Dogfooding the hub means
   teaching it a second data model; revisit when the corpus has real volume.
5. **In-hub sharing of eval and calibration cases.** *Recommended: not in K7.* Real report text leaving a hub is the highest-risk
   action in the product; maintainers and the web form carry cases first, with `checkCase` and paraphrase. Reconsider after the
   anonymizer has run on real cases for a few releases.
6. **Where the installation's opt-in lives: server config or a persisted hub switch.** *Recommended: server config* (`community.share`).
   A persisted switch needs a store table and a migration for a value the adopter's developer should own anyway.
7. **The zip's public password (ZipCrypto) or a plain zip.** *Recommended: the public password,* as the scope doc says: it keeps
   scanners from reading the words, at the cost of ~150 lines of reader code that only ever sees signed bytes.
8. **Pin or follow as the documented default.** *Recommended: show `pin` first* and require the choice in the types. The scope doc says
   releases are pinned and updates are opt-in.
9. **Release cadence.** *Recommended: monthly, plus emergency patches within 48 hours (best effort) for confirmed innocent-text
   blocks.* The project promises no SLA; the numbers are targets.
10. **Hide untouched community rows from `GET /terms` by default.** *Recommended: yes, with `exposeCommunityRows` for adopters who want to
    browse.* It keeps the full list out of every moderator's browser, and `hub-react` already works one row at a time from the Blocked
    screen.
11. **A subpath or a new package for the loader.** *Recommended: the subpath,* with the folder exemption (ruling 5). Choose the package
    only if the exemption is judged too risky; the cost is the eleven-package first-publish dance.
12. **Who are the reviewers (owner).** *Recommended:* two English (the owner and one trusted moderator, as the design note's open
    question 6a asked), one Spanish, one Portuguese, each fluent; the first release ships mostly `provisional` until they have approved.
13. **The seed.** *Recommended: Moxgate's exported production list as `provisional` with a source per term, with the one in-group term
    `defaultActive: false`,* as the design note decided. The owner exports it; it never touches git.
14. **Cloudflare and Zenodo terms check (owner).** *Recommended: read both before the first upload and keep the "we will move" note;*
    if either is a no, the format and keys are unaffected.

## 23. Rulings

*(To be filled by the controller when the questions above are answered.)*
