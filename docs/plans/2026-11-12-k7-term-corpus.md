# K7: the shared term corpus, and published calibration and eval sets (Implementation Plan)

> **For agentic workers:** use superpowers:subagent-driven-development. One implementer per task, a review per task, a whole-branch
> review at the end. Steps are test-first: write the failing tests, see them red, then make them green. Run targeted tests only;
> never a full suite.

**Goal:** an adopter can opt in to a vetted, community-maintained term list that is **signed, cached on disk, loaded server-side only, and
never trusted until it verifies**; a moderator can offer one of their own terms to it from behind the term editor; and the project can run
the service that serves, reviews and releases it for free on Cloudflare, with Zenodo as an archive. The same machinery publishes calibration
and eval sets.

**Two deliverables, built in one branch, deployed separately:**
- **Part A, the kit** (`packages/*`): ships in the next npm release. Everything in it works with no service and no keys; with no keys in
  `CORPUS_KEYS` the loader answers `no_trusted_keys` and the hub shows no Community list.
- **Part B, the service** (`services/corpus`, a private workspace): never published to npm. The owner deploys it with `wrangler` after the
  one-time actions in the design (section 17). It depends on Part A's verifier and word-folding only.

**Architecture (Part A):**
- `@chatwarden/matcher` gets `src/corpus/` (isomorphic: `keys.ts`, `errors.ts`, `sign.ts`, `index-file.ts`, `zip.ts`, `release.ts`, `select.ts`,
  `loader.ts`, `share.ts`, `evalset.ts`, `index.ts`) and `src/corpus/node/` (`fileCache.ts`, `installationKey.ts`, `start.ts`, `index.ts`).
  New subpaths `@chatwarden/matcher/corpus` and `@chatwarden/matcher/corpus/node`. The root entry imports neither.
- `LiveTerms.syncPack` in `packages/matcher/src/liveTerms.ts` (browser-safe, no I/O).
- `@chatwarden/core`: three names only (`term.share`, `community.apply`, target type `release`).
- `@chatwarden/http`: `src/admin/community.ts` (new routes), `terms.ts` (hidden community rows, `GET /terms/:id`, `POST /terms/lookup`).
- `@chatwarden/hub-react`: the Share disclosure in `terms/TermForm.tsx`, a lazy Settings section `settings/Community.tsx`, the Changed cell.
- No store migration. No new npm package. No change to the chat path.

**Architecture (Part B):** `services/corpus/` holds `src/worker.ts` (routes), `src/arrival.ts`, `src/review.ts`, `src/reports.ts`,
`src/counters.ts`, `src/build/` (the release builder and gates), `tools/` (`keygen.mjs`, `release.mjs`, `sign.mjs`, `publish.mjs`,
`zenodo.mjs`, `verify-live.mjs`), `schema.sql`, `wrangler.toml` (placeholders, no ids), `README.md`, `PRIVACY.md`, `SOURCES.md`. D1 is
tested through `node:sqlite` with the same DDL; R2 and the Worker environment are small fakes. No miniflare.

**Spec:** `docs/design/2026-11-12-k7-term-corpus.md` (section numbers below refer to it), including its closing Rulings section once the
controller fills it. Also binding: `docs/design/2026-11-09-product-scope.md` section 9, the "Where the terms themselves live" section of
`docs/design/2026-11-09-chatwarden-design.md`, `docs/design/2026-11-09-moderation-standards.md` (conduct levels), and the 0.1.3 hardening
plan (`docs/plans/2026-11-11-hardening-0.1.3.md`, Task 1) for what not to repeat.

## Global Constraints
- Rules from `AGENTS.md` and `CLAUDE.md`: Apache-2.0 and DCO (`git commit -s`), ESM, `erasableSyntaxOnly` (no parameter properties, no
  enums), every time from an injected `Clock` (no `Date.now()` in package code), test-first, targeted runs only, `npm run lint` and
  `npm run typecheck` before every push. With more than one agent in the worktree: commit by pathspec, `git add` new files first.
  Branch `k7`, worktree `C:\dev\chatwarden-wt\k7`.
- **NO real slur, hateful term or abusive phrase anywhere**: code, tests, fixtures, snapshots, comments, docs, commit messages, PR text.
  Invented words only: zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn (and generated forms such as `zorbak1`). The
  benchmark pack (Task 4) is generated from syllables at run time, not committed. The real corpus never touches git: it lives in
  `.corpus-data/` (git-ignored, outside the tree if possible) and on the service.
- **No term data in any npm tarball and none reachable from a browser entry** (design 16). The root of `@chatwarden/matcher` imports
  nothing from `corpus/`. `packages/matcher/src/corpus/node/` is the only folder under `packages/matcher/src` that may import `node:`.
- **Errors and logs carry codes, never content.** `CorpusError` has fixed messages. Logs hold `{ stage, code }` and counts. Never a term, a
  line, a URL query, a path or a key. Reuse the kit's `safeWarn` and `ThrottledWarn`.
- **Verify, then parse.** No byte of a download is unzipped, parsed or cached as "good" before its signature verified. The disk is
  untrusted: a cached file is verified again on every use.
- **Fail-closed, available.** Any failure keeps the previously applied list; nothing here may empty or weaken a game's filter or throw into
  the chat path. `cw.chat.accept` never awaits the loader.
- **The adopter's edit wins**: `syncPack` never changes a row with `updatedBy !== null` and never deletes.
- **No identifier leaves the kit in a share** (design 10.2): no chat line, name, subject, seat, client key, account id, IP, room, hit or
  excerpt; the payload is built from a closed list of keys.
- **UI rule (clean core, power behind one door).** No new always-visible control, badge or counter on the Terms screen. The Share action is a
  disclosure in the existing term editor; everything else is in a new Settings section that exists only when the server wired
  `community`. Every string through `t()`, no string contains a term. Check Task 11 in a real browser at desktop and 360 px, light and dark.
- All new public names are `@experimental` in TSDoc and listed so in the READMEs until 0.2. The API lock snapshots are updated deliberately.
- Budgets may only go down, apart from a stated reason: the hub's first-load budget (76,800 bytes), the browser bundle budget in
  `scripts/browser-bundle.test.ts` and `hub-element`'s bundle test must stay green; the Community section is lazy.
- Privacy of the plan itself: nothing outward. No push, no publish, no tag, no deploy, no key generation for production, no Cloudflare or
  Zenodo call without the maintainer's go-ahead. Tests use generated keys; production keys never appear anywhere in the repo history.

## Review Focus
Six failure modes no happy-path test would exercise. Each has its test in the owning task.
1. **Unverified bytes used.** A wrong-key, truncated, flipped-bit, replayed-old, wrong-kind or tampered-cache release reaching the parser,
   the cache or the live list. Tasks 2, 3, 6.
2. **The list getting weaker or empty.** Every failure path, every partial write, a refused `syncPack`, a second refresh racing the first:
   the applied list is byte-for-byte the same afterwards. Tasks 5, 6.
3. **An adopter's choice overridden.** A switched-off term coming back; a renamed row changed; a row deleted. Task 5.
4. **Term data reaching a browser or a tarball.** An import path, a hub response, a packed file, a log line. Tasks 7, 10, 12.
5. **Identifiers or chat in a share.** The payload, headers, errors, logs and audit rows, including error paths. Tasks 8, 10.
6. **The slow list.** Thousands of rows making an edit or a chat check slow enough to matter. Task 4 measures it before the limits are fixed.

## Order and parallelism
Step 0 first. **Part A:** Tasks 1, 2, 3, 5 and 9 are independent and can run at once. Task 4 follows 2 and 3. Task 6 follows 2, 3, 4 and 5.
Task 7 follows 6. Task 8 follows 2. Task 10 follows 1 and 5. Task 11 follows 10. Task 12 follows 7 and 10. Task 13 follows 11 and 12. Task 14
is last. **Part B:** S1 first; S2, S3, S5 and S9 follow it and are independent; S4 follows S3; S6 follows S2, and Part A Tasks 2 and 4; S7
follows S6 and Part A Task 2; S8 follows S7; S10 last. Part B does not wait for Part A's release, only for the code in the branch.

---

## Step 0 (before Task 1)
- Rebase on `main`. Check: (a) whether `AUDIT_ACTIONS` in `packages/core/src/audit.ts` already holds names added by the appeals or flood
  work, and keep both; (b) whether `examples/ai-anthropic/eval/cases.ts` is on `main` (if not, Task 9's compatibility test reads it only
  when the file exists, and the compatibility check is repeated when the AI branch lands); (c) the current peer floors in
  `scripts/manifests.test.ts`.
- Run `npx vitest run packages/matcher/test/termPack.test.ts packages/matcher/test/liveTerms.test.ts` for a green baseline.

---

# Part A: the kit

### Task 1: Core names
Design 8.6. Tiny and independent.
- **Files:** `packages/core/src/audit.ts` (`AUDIT_ACTIONS` += `term.share`, `community.apply`; `AUDIT_TARGET_TYPES` += `release`; the doc
  comment on `ref` allows a version such as `2026.12.0`), `packages/hub-react/src/auditLabel.ts` and the audit words in `i18n.ts` (a label
  for each), `packages/hub-react/src/screens/Audit.tsx` only if it filters by a closed list; tests `packages/core/test/audit.test.ts`,
  `packages/store-sqlite/test/audit.store.test.ts`, `packages/hub-react/test/audit-labels.test.tsx` (extend the existing one if present).
- **Interfaces (Produces):** the three names, nothing else. `AuditService.record` accepts `{ action: 'term.share', target: { type: 'term',
  ref } }` and `{ action: 'community.apply', target: { type: 'release', ref: '2026.12.0' } }`.
- **Tests (names):**
  - `audit: term.share and community.apply are recorded and listed; release is an accepted target type`
  - `audit: a ref with dots such as 2026.12.0 is accepted; a ref with a slash, a space or 65 characters is refused`
  - `audit: neither new action carries a detail; a word in the ref position is not required nor stored` (ids only)
  - `sqlite: both new actions round-trip through the audit table without a migration (the filter is built from AUDIT_ACTIONS)`
  - `hub: both actions have a label in the audit list and a screen-reader label`; `hub: an unknown future action still renders`
- **Run:** `npx vitest run packages/core/test/audit.test.ts packages/store-sqlite/test/audit.store.test.ts`, then `npx vitest run packages/hub-react/test/audit-labels.test.tsx`.

### Task 2: Signatures, keys, index and sig formats (matcher/corpus)
Design 6.2, 6.3, 7, 8.1. Pure, isomorphic.
- **Files:** `packages/matcher/src/corpus/keys.ts`, `errors.ts`, `sign.ts`, `index-file.ts`, `index.ts` (all new); tests
  `packages/matcher/test/corpus-verify.test.ts`, `corpus-index.test.ts`; a test helper `packages/matcher/test/corpus-world.ts` (generates
  an Ed25519 pair with `crypto.subtle`, signs, builds indexes and sig files).
- **Interfaces (Produces):** `CorpusKey`, `CORPUS_KEYS` (an empty frozen array until the owner's keys are added in the release step),
  `CORPUS_REVOKED_KEY_IDS` (frozen, empty), `CORPUS_BASE_URL`, `CORPUS_ZIP_PASSWORD`, `CorpusStage`, `CorpusErrorCode`, `CorpusError`,
  `signedMessage`, `verifySignature`, `parseIndex(json, now)` returning a typed `CorpusIndex` or throwing `CorpusError('bad_index')`,
  `chooseRelease(index, { kind, pin?, follow?, kit })`. The message is `UTF8('chatwarden-corpus/1') ‖ 0x00 ‖ UTF8(kind) ‖ 0x00 ‖ bytes`.
  Base64url helpers are local (no `Buffer`, no `atob`-only assumptions).
- **Behaviour:** `verifySignature` imports a key with `crypto.subtle.importKey('raw', …, 'Ed25519')`; an empty key list is
  `no_trusted_keys`; a key listed in `CORPUS_REVOKED_KEY_IDS` or in the index's `revokedKeyIds` (only honoured when the index itself
  verified under another key) is `revoked_key`; an unknown id is `unknown_key`; any other failure is `bad_signature`. `CorpusError`
  messages are a fixed table by code.
- **Tests (names):**
  - `signedMessage: prefix, separators and kind are exactly as specified; different kinds give different bytes`
  - `verifySignature: a valid signature verifies for its kind and fails for the other two kinds` (domain separation)
  - `verifySignature: one flipped bit in the bytes, the signature or the key id fails`; `a wrong key, an unknown key id, a revoked key id fail with their own codes`
  - `verifySignature: alg other than Ed25519, a 63-byte and a 65-byte signature, non-base64url text, null, an array, a getter that throws, a proxy: CorpusError and nothing else`
  - `verifySignature: an empty key list is no_trusted_keys; the first of two keys that matches wins; the second is tried when the first does not match`
  - `parseIndex: round-trips the design's example; unknown major schema, negative or non-integer sequence, missing latest, duplicate versions, a zip path with .. or a scheme, an expiresAt in the past (index_expired), a malformed date: each refused with its code`
  - `chooseRelease: pin finds its version; a pin that is absent is no_such_version; follow takes latest.terms; a revoked release is revoked_release; minKit above the kit is kit_too_old (compare as numbers, 0.1.10 above 0.1.9)`
  - `CorpusError: no message contains any string from the input` (feed each failure an input full of invented words)
  - `in a vm context with only browser globals, verifySignature works` (WebCrypto only; no Buffer, no process)
- **Run:** `npx vitest run packages/matcher/test/corpus-verify.test.ts packages/matcher/test/corpus-index.test.ts`

### Task 3: The zip reader (matcher/corpus)
Design 6.4. Pure, hostile-input tolerant, isomorphic (`DecompressionStream('deflate-raw')`).
- **Files:** `packages/matcher/src/corpus/zip.ts` (new); test `packages/matcher/test/corpus-zip.test.ts`; test helper `corpus-zip-writer.ts` (a
  tiny zip writer with stored and deflate entries and ZipCrypto, for fixtures; test-only).
- **Interfaces (Produces):** `ZipLimits = { entries: 32; compressed: 8 * 1024 * 1024; expanded: 32 * 1024 * 1024; name: 64 }`,
  `readZip(bytes, options?)` returning `Map<string, Uint8Array>`. Traditional PKWARE ZipCrypto (the three-key cipher; 12-byte header, check
  byte from the CRC or the DOS time), methods 0 and 8, central directory only (the local header is cross-checked), CRC-32 verified, names
  validated (`^[A-Za-z0-9._-]{1,64}$`, no duplicates), no zip64, no multi-disk, an expanded-size budget enforced while inflating (the
  declared size is not trusted).
- **Tests (names):**
  - `reads stored and deflated entries, with the right password`; `a wrong password is bad_zip (the check byte or the CRC), not a throw of another class`
  - `a CRC mismatch, a truncated archive, a truncated central directory, a comment longer than the file, an offset past the end: bad_zip`
  - `a name with a slash, a backslash, .., a leading dot-dot, 65 characters, a duplicate, or a control character is refused`
  - `33 entries and an archive of 8 MiB + 1 are refused; a deflate bomb (a few KB expanding past 32 MiB) stops at the budget and allocates no more than it` (Review Focus 1)
  - `zip64 records, an encrypted entry with the AES flag, a data descriptor with a zero size, method 12 (bzip2): refused`
  - `the reader never reads outside the buffer`: fuzz 500 mutated archives with a seeded PRNG; each is a map or a CorpusError
  - `the expanded bytes equal the bytes written, for an empty file, a 1-byte file, a 1 MiB file and non-ASCII UTF-8 content`
- **Run:** `npx vitest run packages/matcher/test/corpus-zip.test.ts`

### Task 4: Release parsing, selection, collisions, and the size benchmark
Design 6.5 to 6.7, 9 (performance), 13. Needs Tasks 2 and 3.
- **Files:** `packages/matcher/src/corpus/release.ts`, `select.ts` (new); tests `packages/matcher/test/corpus-release.test.ts`,
  `corpus-select.test.ts`, `corpus-bench.test.ts`; helper additions in `corpus-world.ts` (build a synthetic release zip with the writer).
- **Interfaces (Produces):** `TermsRelease`, `TermRow6`, `ExceptionRow6`, `NegativeFile`, `parseTermsRelease(files)` (strict keys; checks
  `kind`, every `files` hash, `gate.passed`, unique ids, unique word keys using `collapseLikePreset(foldTerm(term))`), `PackSelection`,
  `releaseToPack(release, select)` (maps to a `TermPack` with `id: 'chatwarden-corpus'`, `version`, active per the design's rule,
  `negativeCorpus` and `knownLosses` merged for the selected languages, `positiveCorpus`), then `loadTermPack` is run on the result.
- **Behaviour:** `statuses` default both accepted and provisional; `disputed` and `withdrawn` are always included inactive;
  `defaultActive:false` is inactive; `collidesWith` turns a row off when any other selected language is in the list; `minSeverity` default
  `hostile`; `pt-BR` selects `pt`; an empty selection (no language) is a `RangeError` naming the option, not a value.
- **Tests (names):**
  - `parseTermsRelease: the example round-trips; every field's allowed and refused values (category, target, severity, status, id shape)`
  - `a term that folds to the same word as another is refused; accents, fullwidth forms and look-alikes in a term as written are handled by foldTerm`
  - `a manifest whose file hash differs, whose version differs from the index entry, whose kind is eval, or whose gate.passed is false: refused`
  - `releaseToPack: languages, categories, minSeverity and statuses select as documented; defaults are hostile and both statuses`
  - `releaseToPack: a disputed and a withdrawn row load inactive; a defaultActive:false row loads inactive; none is ever switched on by the loader`
  - `releaseToPack: collidesWith switches a row off only when the colliding language is also selected`
  - `releaseToPack: the result passes loadTermPack and builds with buildMatcher; positive lines of an active term are matched by it, negative lines of every term are not` (a generated pack of invented words)
  - `no function in release.ts or select.ts puts a term or line in an error message` (Review Focus 4)
  - `benchmark (informational, gated by CW_BENCH=1 so CI stays fast, plus a fast always-on check at 500 terms): a generated 5 000-term pack builds in under 300 ms; match of a 200-character line under 2 ms; changeSync of one edit under 600 ms` — **record the measured numbers in the PR and in design section 9; if a budget fails, fix it here (memoise the terms-only matcher in `validate()`; tighten the default selection) before Task 5 is built on it**
- **Run:** `npx vitest run packages/matcher/test/corpus-release.test.ts packages/matcher/test/corpus-select.test.ts packages/matcher/test/corpus-bench.test.ts`; `CW_BENCH=1 npx vitest run packages/matcher/test/corpus-bench.test.ts` once.

### Task 5: `LiveTerms.syncPack`
Design 8.3. Independent of the loader.
- **Files:** `packages/matcher/src/liveTerms.ts` (make `pack` replaceable; add `syncPack`; an internal insert that takes an explicit id),
  `packages/matcher/src/termStore.ts` (no change expected; check `setTermActive` stamps `updatedBy`), `packages/matcher/src/index.ts`
  (export `SyncResult`, `SyncSummary`); tests `packages/matcher/test/liveTerms.sync.test.ts`; the shared `MemoryTermStore` fixture and
  `packages/store-sqlite/test/terms.store.test.ts` (add a sync case so both stores agree).
- **Interfaces (Produces):** `LiveTerms.syncPack(pack: TermPack, options: { actor: string; dryRun?: boolean }): SyncResult` as design 8.3.
- **Behaviour:** one `store.transaction`; adds with the pack's ids and `addedBy: actor`; untouched rows (`updatedBy === null`) follow the
  pack's `active` and text; touched rows are counted `keptYours`; a word that already reads as the same word under another id is
  `skipped`; exceptions the same; then `validate()`; on success `this.pack = pack` and the matcher swaps; on a refusal nothing is
  written and `this.pack` is unchanged; `dryRun` runs the same logic inside a transaction that is rolled back (a thrown sentinel) and
  returns the summary. Returns `not_loaded` before `load()`.
- **Tests (names):**
  - `syncPack: adds new rows with the corpus actor, follows an untouched row's text and active, and writes the existing audit rows`
  - `syncPack: a row a moderator toggled, renamed or re-noted is kept (keptYours) and is never reactivated or deactivated` (Review Focus 3)
  - `syncPack: a term the adopter added is never touched; nothing is ever deleted; a withdrawn pack row only deactivates`
  - `syncPack: a duplicate word under another id is skipped; two syncs of the same pack are a no-op (all zeros)`
  - `syncPack: a pack that leaves no active term, or whose exception would unblock a positive line, is refused with the existing codes and writes nothing` (Review Focus 2)
  - `syncPack: dryRun returns the same summary and leaves store, audit and matcher untouched`
  - `syncPack: after success check() uses the new pack's negative corpus and the canary uses the new positive lines`
  - `syncPack: not_loaded before load(); build_failed when the store throws mid-way, with everything rolled back`
  - `syncPack: the same results on MemoryTermStore and on the SQLite store`
- **Run:** `npx vitest run packages/matcher/test/liveTerms.sync.test.ts packages/matcher/test/liveTerms.test.ts packages/store-sqlite/test/terms.store.test.ts`

### Task 6: The loader
Design 8.1, 9. Needs Tasks 2 to 5.
- **Files:** `packages/matcher/src/corpus/loader.ts` (new); tests `packages/matcher/test/corpus-loader.test.ts`,
  `corpus-loader-failures.test.ts`; helper additions to `corpus-world.ts` (a fake `fetch` serving an index, sigs and zips, with switches for
  every fault; an in-memory `CorpusCache` that can fail mid-write).
- **Interfaces (Produces):** `createCorpusLoader`, `CorpusLoader`, `CorpusLoaderOptions`, `CorpusStatus`, `CorpusState`, `RefreshResult`,
  `CorpusCache`, `Schedule` exactly as design 8.1.
- **Behaviour:** the refresh sequence of design 9, in order; the cache layout of 8.2 (`index.json`, `index.json.sig`,
  `releases/<kind>-<version>.zip(.sig)`, `state.json` written last); the disk is verified again on every use; one refresh at a time
  (a second call awaits the first); `fetch` timeouts via an injected `AbortSignal.timeout`-style helper that uses the `Clock`-free `schedule`;
  `applyTo` calls `syncPack`; `apply: 'auto'` applies inside `refresh()`; `start()` returns a stop function and ticks with
  jitter; nothing throws out of `refresh()`, `status()` or `start()`.
- **Tests (names):** one per row of the design's failure table, each asserting (a) `status()` code and stage, (b) the live list unchanged,
  (c) the log holds `{ stage, code }` only, plus:
  - `happy path: first refresh downloads, verifies index then zip, unzips, builds the pack and writes the cache; the second refresh makes one conditional request and no download`
  - `pin: never moves; fetches its version if the cache lacks it; follow: moves to latest after a newer index; apply manual leaves pending and apply auto syncs`
  - `a tampered cached zip, a tampered cached sig and a cached state.json from a newer sequence are handled: re-download or rollback refusal` (Review Focus 1)
  - `an interrupted cache write (fail after the zip, before state.json) leaves the previous release in use`
  - `the base URL fails and the Zenodo-style mirror serves the same bytes: accepted because the signature verifies; a mirror serving other bytes: hash_mismatch`
  - `two refreshes started together share one download`; `a hanging fetch times out at the limit; a throwing fetch is offline`
  - `the seed: a verified seed is applied on first start with no network; an unverified seed is ignored with bad_signature and the loader continues`
  - `start(): ticks on the schedule with jitter, stops on the returned function, and never overlaps two refreshes`
  - `the index sequence only ever rises in state.json`; `index_expired keeps the applied list and reports stale`
  - `nothing in the loader calls Date.now; the fake clock drives expiry and timestamps`
- **Run:** `npx vitest run packages/matcher/test/corpus-loader.test.ts packages/matcher/test/corpus-loader-failures.test.ts`

### Task 7: The Node subpath, exports, and the lint exemption
Design 8.2, 16. Needs Task 6.
- **Files:** `packages/matcher/src/corpus/node/fileCache.ts`, `installationKey.ts`, `start.ts`, `index.ts` (new); `packages/matcher/package.json`
  (`exports` and `typesVersions` for `./corpus` and `./corpus/node`; `sideEffects` stays false); `eslint.config.js` (a narrow override for
  `packages/matcher/src/corpus/node/**` only); `vitest.config.ts` (aliases, more specific first); `tsconfig` if the folder needs it;
  tests `packages/matcher/test/corpus-node.test.ts`, `scripts/eslint-ban.test.ts` (extended), `scripts/browser-bundle.test.ts` (extended).
- **Interfaces (Produces):** `fileCache(dir)`, `installationKey(dir)`, `startCorpus(options)` exactly as design 8.2; the cache writes to
  `name.tmp-<random>` then renames; mode 0600 and 0700 where the platform supports it; a name with a separator, `..` or a NUL is refused.
- **Tests (names):**
  - `fileCache: write then read round-trips; a crash between the temporary file and the rename leaves the old file whole; names with / \\ .. or NUL are refused; remove of a missing file is not an error`
  - `installationKey: generated once, reloaded on the next call, public key is 32 bytes base64url, sign verifies with verifySignature('submission'-style message)`
  - `startCorpus: never rejects (a bad dir, an offline fetch, a bad cache); returns within the bound; the periodic timer is unref'd and stops on the returned function`
  - `eslint-ban: node: imports are refused in packages/matcher/src/x.ts and packages/matcher/src/corpus/x.ts, and allowed in packages/matcher/src/corpus/node/x.ts` (both halves pinned)
  - `browser-bundle: the root entry bundle (and the hub-react and hub-element graphs) has no input under matcher/dist/src/corpus and no 'chatwarden-corpus' string; a bundle of @chatwarden/matcher/corpus alone has no node: specifier and runs verifySignature in the bare vm`
  - `exports: @chatwarden/matcher/corpus and /corpus/node resolve under ESM and under CommonJS with moduleResolution node (typesVersions)`
- **Run:** `npx vitest run packages/matcher/test/corpus-node.test.ts scripts/eslint-ban.test.ts`, then (after `npm run build`) `npx vitest run scripts/browser-bundle.test.ts`.

### Task 8: The share client
Design 6.8, 8.4, 10.2. Needs Task 2.
- **Files:** `packages/matcher/src/corpus/share.ts` (new; includes `hashcash`), tests `packages/matcher/test/corpus-share.test.ts`.
- **Interfaces (Produces):** `ShareInput`, `ShareResult`, `CommunityShare`, `createCommunityShare`, `mintStamp(body, bits)` and `checkStamp`.
- **Behaviour:** the payload is built from the closed key list `schema, term, language, category, target, note, day, kit` and nothing else
  (extra keys on the input are ignored, never forwarded); `day` comes from the injected `Clock` (UTC date only); the note rules (200
  characters, no URL, no `@`, no digit run over 4) are checked before sending and return `invalid`; the body is serialised once and the
  same bytes are signed and sent; the stamp is minted over those bytes; each service answer maps to a `ShareResult`; a network failure is
  `offline`; no error carries the service's text.
- **Tests (names):**
  - `payload: exactly the allowed keys, in a snapshot; extra keys on the input (client key, subject, line, hits) are not sent` (Review Focus 5)
  - `no seeded identifier appears in the body, the headers or any error: client key, subject id, seat, account, IP, room, a chat line, a handle`
  - `day is a calendar day from the injected clock, never a time`; `note: 200 ok, 201 refused; a URL, an @name, a 5-digit run: refused; null ok`
  - `the signature verifies over signedMessage('submission', body); a changed body fails; the stamp meets the bit count and checkStamp refuses one bit short`
  - `each service answer (202 received, 200 known, 200 duplicate, 400 codes, 401, 429 with retry-after, 500, a non-JSON body) maps to a ShareResult with no service text`
  - `status(id): signed GET; unknown id is null; a malformed answer is null`
- **Run:** `npx vitest run packages/matcher/test/corpus-share.test.ts`

### Task 9: The eval set reader
Design 6.10, 12. Independent.
- **Files:** `packages/matcher/src/corpus/evalset.ts` (new); tests `packages/matcher/test/corpus-evalset.test.ts`.
- **Interfaces (Produces):** `EvalSet`, `EvalCaseFile` (the AI eval's `EvalCase` shape plus optional `meta`), `parseEvalSet(files)`.
- **Behaviour:** strict keys per case; `group` any non-empty string (the eval's `CASE_GROUPS` list is advisory, since the AI package is not a
  dependency); `lines[].who` one of `reported | reporter | other`; `expect.severity` a `ConductLevel` or a non-empty array of them;
  `verdict` one of four; `mustCite` and `mustNotCite` integers from 1 to `lines.length`; `pointedAt` the same; at most 12 lines, 200
  characters a line, 500 cases a file; `meta` kept but its unknown keys ignored.
- **Tests (names):**
  - `parses the design's example; every expect shape (single level, a band), optional keys absent`
  - `refuses: an unknown who, a citation outside the lines, 13 lines, a 201-character line, 501 cases, a duplicate id, an unknown top-level key, __proto__`
  - `compat: when examples/ai-anthropic/eval/cases.json exists (the AI branch), every case in it parses unchanged` (skipped otherwise, with a note to rerun when the AI branch lands)
  - `parseEvalSet: a manifest of kind terms is refused; counts in the manifest must equal the files`
  - `a speaker value that looks like a handle, an id or an email in text is not rejected here (that is the service's checkCase) but never appears in an error`
- **Run:** `npx vitest run packages/matcher/test/corpus-evalset.test.ts`

### Task 10: Staff routes (http)
Design 8.5. Needs Tasks 1 and 5 (types).
- **Files:** `packages/http/src/admin/community.ts` (new), `packages/http/src/admin/terms.ts` (hidden community rows; `GET /terms/:id`;
  `POST /terms/lookup`; `exposeCommunityRows`), `packages/http/src/admin/index.ts` (option `community`), `packages/http/src/permissions.ts`
  (no new keys: `terms.read`, `terms.write`, `settings`), `packages/http/src/admin-entry.ts` and `index.ts` (export the structural types);
  tests `packages/http/test/admin.community.test.ts`, `admin.terms-community.test.ts`, additions to `exports.test.ts`.
- **Interfaces (Produces):** `CommunityAdmin` (structural: `loader: { refresh(); status(); applyTo(terms, actor?) }`, `live: TermsAdmin &
  { syncPack }`, `share?: { share(input); status(id) }`), the routes of design 8.5, and the `community: { hidden }` field of `GET /terms`.
  A community row is `addedBy` starting `corpus:` and `updatedBy === null`.
- **Tests (names):**
  - `GET /community: shape, no term anywhere in the body, sharing true only with a share object, 404 when community is not wired`
  - `POST /community/refresh needs terms.write; POST /community/apply needs settings (owner) and writes a community.apply audit row with target release:<version>`
  - `GET /terms: lists the adopter's rows and touched community rows, omits untouched community rows and reports community.hidden; exposeCommunityRows lists them` (Review Focus 4)
  - `GET /terms/:id returns a hidden row; an unknown id is 404; POST /terms/lookup finds an exact word (folded) and is 404 for a miss; the word is only ever in the body`
  - `POST /terms/:id/share: needs terms.write; a community row cannot be shared (409); the body is validated (category, target for slurs, note rules); the audit row holds the term id and never the word; the answer is { status } only`
  - `a failed share is a fixed error code and never the service's text; a throwing share object is a 502 with a fixed message`
  - `no identifier or word in any response, header or log of the new routes` (seed distinctive keys; Review Focus 5)
  - `routes are absent (404) when community is not passed, and the existing term routes are byte-identical`
- **Run:** `npx vitest run packages/http/test/admin.community.test.ts packages/http/test/admin.terms-community.test.ts packages/http/test/admin.terms.test.ts packages/http/test/exports.test.ts`

### Task 11: The hub
Design 14. Needs Task 10.
- **Files:** `packages/hub-react/src/terms/TermForm.tsx` (the Share disclosure; "Report a problem with this community term"),
  `packages/hub-react/src/terms/ShareTerm.tsx` (new), `packages/hub-react/src/settings/Community.tsx` (new, lazy), `screens/Settings.tsx`
  and `router.ts` (a `community` section shown when `GET /community` exists), `screens/Terms.tsx` (the Changed cell reads "Community
  list <version>" for `corpus:` rows; fetches one hidden row by id from a handoff), `client.ts` and `types.ts` (`community`,
  `refreshCommunity`, `applyCommunity`, `shareTerm`, `shareStatus`, `getTerm`, `lookupTerm`), `i18n.ts` (the words; none contains a term),
  `index.ts`, `test/api.test.ts` (the lock), `lazyParts.tsx`; tests `packages/hub-react/test/community.test.tsx`,
  `community-a11y.test.tsx`, `terms.test.tsx` (additions).
- **Behaviour:** per design 14. The consent text is the catalogue string of design 10.5. Send is enabled only after the disclosure has
  been open; the preview shows the word masked unless Show words is on. After a send the disclosure shows the status in words and stays
  closed on later opens of a row already shared. The Community section is a lazy chunk (first-load budget unchanged).
- **Tests (names):**
  - `Terms: no new always-visible control, badge or counter with community wired or not` (a structural snapshot of the screen's buttons and tags)
  - `Share disclosure: absent without sharing:true and for a community row; closed by default; opening shows the exact payload and the consent text; Send posts one term; the draft is lost on close`
  - `the payload preview masks the word until Show words; the words in the dialog contain no term`
  - `each share status (received, in_review, accepted, declined with each closed reason, offline, rate_limited) has words; none shows service text`
  - `Settings > Community list: shown only when /community exists; Check now; a failed check shows the code in words; Apply is owner-only and shows the summary before it acts; pending counts never list terms`
  - `Changed cell: "Community list 2026.12" for corpus rows, a person and time otherwise`
  - `a Blocked-screen handoff to a hidden community row fetches that one row and marks it; switching it off makes it a touched row`
  - `axe clean for the disclosure and the section; keyboard: open with Enter, Escape closes and returns focus; the 360 px layout has no horizontal scroll` (layout assertions in the style of existing hub tests)
  - `hub first-load size stays under the budget; the Community chunk is lazy; hub-element's bundle stays one file`
  - `public API lock: the new names, nothing removed`
- **Run:** `npx vitest run packages/hub-react/test/community.test.tsx packages/hub-react/test/community-a11y.test.tsx packages/hub-react/test/terms.test.tsx packages/hub-react/test/api.test.ts`; then check Terms, its Share disclosure and the Community section in a real browser at desktop and 360 px, light and dark.

### Task 12: Repo guards
Design 16, 18. Needs Tasks 7 and 10.
- **Files:** `scripts/no-corpus-data.test.ts` (new), `scripts/check-pack.mjs` and `scripts/check-pack.test.ts` (no `.zip`, `.sig`, key or corpus-schema
  JSON in a packed tarball), `.gitignore` (`.corpus-data/`, `*.pem`, `*.key`, `.dev.vars`), `site/test/dist.test.ts` (the corpus markers),
  `AGENTS.md` (the rule gains "and no corpus data, no key"), `scripts/browser-bundle.test.ts` (if not complete in Task 7).
- **Behaviour of the guard:** list tracked files (`git ls-files`); for each JSON file with a `schema` starting `chatwarden-corpus-`, every
  `term`, `phrase`, and line word must be in the invented-word allowlist (the fixtures' words plus generated `*N` forms); fail on any
  tracked `*.pem`, `*.key`, `.dev.vars`, a PKCS#8 header, or an archive (`.zip`, `.7z`, `.tar*`) outside `test/fixtures/` (and those must pass the
  same allowlist when unpacked by the guard). An **allowlist** guard, so no real list is needed to enforce it.
- **Tests (names):**
  - `the guard passes on the repo as it is`
  - `the guard fails on a synthetic file whose term is not in the allowlist` (the test writes a temp tree with an invented-but-unlisted word, not a real one)
  - `the guard fails on a PEM, a key file, a .dev.vars and a zip outside fixtures`
  - `check-pack: no packed tarball holds a zip, a sig or corpus JSON`
  - `site dist: the built page has none of the corpus module markers`
- **Run:** `npx vitest run scripts/no-corpus-data.test.ts scripts/check-pack.test.ts`; `npm test --workspace @chatwarden/site -- test/dist.test.ts`.

### Task 13: Docs (Part A)
Design 21. Needs Tasks 11 and 12.
- **Files:** `packages/matcher/README.md` (replace "That corpus is not released yet": loader, pin or follow, offline-first, seed, the no-terms-in-package
  statement, the attribution sentence, `syncPack`), `packages/http/README.md` (community routes), `packages/hub-react/README.md` (the Community
  list section), `README.md` (an "I want to" row), `docs/status.md`, `docs/plans/follow-ups.md` (the items of design 20), `CLAUDE.md` (the "Before
  you change an area" table: K7), `docs/design/2026-11-12-k7-term-corpus.md` (rulings, by the controller, not here); tests
  `scripts/readme.test.ts` (the new code blocks compile), `packages/matcher/test/readme.test.ts`.
- **Tests (names):** `the readme code blocks for the loader, syncPack and the share client compile and run against fakes`; `every documented
  option name exists`; `the READMEs list the @experimental names`; `no README contains a term` (the allowlist guard's word scanner over code blocks).
- **Run:** `npx vitest run scripts/readme.test.ts packages/matcher/test/readme.test.ts`

### Task 14: Release prep (Part A)
See Release. Changeset, `npm run version`, peer floors, `npm run check:pack` after deleting `dist`, `node scripts/smoke.mjs`.
- **Tests (names):** `manifests: the published set is still the ten, none private`; `http and hub-react core floors, and hub-react's http floor, are
  the new version and nothing else moved` (a new set in `scripts/manifests.test.ts` beside `NEEDS_NEW_KIT`); `publish-order is unchanged`;
  `check-pack: @chatwarden/matcher/corpus and /corpus/node resolve from the packed tarball under ESM and under CommonJS with moduleResolution
  node, and the root entry does not load them`; `smoke: a consumer imports both subpaths in the ESM, CommonJS and no-React projects`;
  `changelog: the new subpaths and the three core names are named`.
- **Run:** `npx vitest run scripts/manifests.test.ts scripts/publish-order.test.ts scripts/release-workflow.test.ts scripts/changelog.test.ts scripts/sync-version.test.ts scripts/check-pack.test.ts scripts/smoke.test.ts`

---

# Part B: the service (`services/corpus`)

Part B is built in the same branch but deployed by the owner. Every task is testable with no Cloudflare account.

### Task S1: Scaffold
- **Files:** `services/corpus/package.json` (private; `@chatwarden/corpus-service`; dev dependencies `wrangler` and `@cloudflare/workers-types` only),
  `tsconfig.json` (added to the root `tsconfig.json` references), root `package.json` `workspaces` += `services/*`, `vitest.config.ts` (the
  `kit` project's `include` += `services/*/test/**/*.test.ts`), `eslint` coverage, `schema.sql` (design 6.9), `wrangler.toml` (placeholders
  and comments, **no account or database ids**), `src/env.ts` (typed bindings), `test/d1.ts` (a D1-shaped adapter over `node:sqlite`:
  `prepare().bind().first()/all()/run()` and `batch`), `test/r2.ts` (a Map-backed bucket), `README.md` (skeleton).
- **Tests (names):** `schema.sql applies cleanly twice (idempotent) and enforces the CHECK constraints (a bad status, a duplicate word_key, a second review by one reviewer)`; `the D1 adapter returns what node:sqlite returns for first, all, run and batch`;
  `the workspace builds with tsc -b and lints`.
- **Run:** `npx vitest run services/corpus/test/schema.test.ts services/corpus/test/d1.test.ts`

### Task S2: Shared gate logic
Design 10.1 (4), 13. Uses the matcher's `foldTerm`, `collapseLikePreset`, `buildMatcher`.
- **Files:** `services/corpus/src/wordkey.ts`, `gates.ts`, `dictionary.ts` (new); tests `services/corpus/test/gates.test.ts`.
- **Interfaces (Produces):** `wordKey(term)`, `arrivalGate(input, db)` (returns a closed code or ok), `crossLanguageGate(candidate, db)` (returns
  `{ collidesWith, negatives[] }`), `innocentRank(db, language, key)`.
- **Tests (names):** `wordKey equals the kit's duplicate key (parity test against loadTermPack's rule for accents, repeats, fullwidth)`; `a word in the top-ranked innocent words is known_innocent; one outside is ok`; `a candidate that contains or collapses to an innocent word of another language lists that language in collidesWith and that word in negatives`; `the gate never throws on odd input (empty, 10 000 characters, emoji, RTL)`; `no message holds the word`.
- **Run:** `npx vitest run services/corpus/test/gates.test.ts`

### Task S3: The submission API (arrival)
Design 6.8, 10.1, 10.4. Needs S1 and S2.
- **Files:** `services/corpus/src/worker.ts` (router), `arrival.ts`, `counters.ts`, `verify.ts` (uses the kit's `verifySignature`-style check on the
  `submission` message and `checkStamp`); tests `services/corpus/test/arrival.test.ts`, `rate.test.ts`.
- **Behaviour:** `POST /v1/submissions` and `GET /v1/submissions/:id` as design 6.8; JSON only (`400` for other content types); body cap 2 KiB
  checked while reading; unknown keys `400`; day window ±1; stamp 16 bits; per-installation and per-network-hash counters in D1 with
  a fake clock; the IP is read from `cf-connecting-ip`, hashed with a salt that rotates daily, and never stored raw; headers
  `cache-control: no-store`, `x-content-type-options: nosniff`, no CORS (server-to-server only); responses contain no reviewer text.
- **Tests (names):**
  - `a valid signed submission is 202 received; the same again is duplicate; an existing term is known with its public id`
  - `every refusal code: invalid (each field), too_large, unsupported_language, stamp (one bit short), 401 (bad, missing, wrong-kind signature), day outside the window, wrong content type, unknown key, a note with a URL`
  - `limits: the 21st submission in a day by one installation is 429 with retry-after; the 61st by one network hash; a declined streak of 10 locks the installation for 7 days; counters older than two days are purged`
  - `no raw IP, no body and no note is logged or stored beyond the schema` (spy on logs and read every table)
  - `GET status needs the same key's signature; another key gets 404; the reason is one of the closed codes`
  - `replay: the same signed body on a later day is refused`
- **Run:** `npx vitest run services/corpus/test/arrival.test.ts services/corpus/test/rate.test.ts`

### Task S4: Review queue and page
Design 10.3. Needs S3.
- **Files:** `services/corpus/src/review.ts`, `access.ts` (verifies the Cloudflare Access JWT against the team's JWKS through an injected
  fetch; checks `aud`), `page/` (one static HTML page with a small script; strict CSP; terms masked until revealed; no framework); tests
  `services/corpus/test/review.test.ts`, `access.test.ts`.
- **Behaviour:** `/admin/*` refuses without a valid Access JWT; reviewers come from a table with per-language `fluent` flags; approve /
  decline (closed reasons) / dispute / restore / add negative line; the rules of design 10.3 enforced in SQL transactions; every action
  audited.
- **Tests (names):** `no JWT, a wrong audience, an expired token, a token for a non-reviewer: 401 or 403`; `one approval makes provisional; a second by the same reviewer is refused; a second by another makes accepted only if one approver is fluent`; `a slur without a target cannot be approved`; `a reviewer cannot approve a submission from a key registered to them`; `a gate failure holds the term with a code`; `every action writes an audit row`; `the page sets a strict CSP and renders no term until revealed`; `a break reminder after 20 reveals`.
- **Run:** `npx vitest run services/corpus/test/review.test.ts services/corpus/test/access.test.ts`

### Task S5: Reports (removal and dispute)
Design 10.6. Needs S1.
- **Files:** `services/corpus/src/reports.ts`, `turnstile.ts` (siteverify through an injected fetch); tests `services/corpus/test/reports.test.ts`.
- **Behaviour:** `POST /v1/reports { termId, kind }` signed by an installation key, or with a Turnstile token for the docs-site form; no free text
  is accepted or stored; one open report per (term, channel-key) per day; reviewer resolution per design 10.4 (one reviewer for a confirmed
  innocent sense, two to restore, two for a slur removal).
- **Tests (names):** `a body with any free-text key is 400`; `a missing or failed Turnstile token is 403`; `duplicate reports in a day collapse`; `a confirmed innocent_sense report sets disputed on one reviewer's verdict; restore needs two; a slur removal needs two`; `the reporter sees an acknowledgement id and nothing about the term`.
- **Run:** `npx vitest run services/corpus/test/reports.test.ts`

### Task S6: The release builder and gates
Design 6.4 to 6.7, 7, 13. Needs S2 and Part A Tasks 2 and 4.
- **Files:** `services/corpus/src/build/templates.ts` (positive-line templates), `build/release.ts`, `build/gates.ts`, `build/diff.ts`,
  `build/zip.ts` (the writer, shared with the kit's test helper by copy, with its own tests), `tools/release.mjs`; tests
  `services/corpus/test/build-*.test.ts`.
- **Behaviour:** reads accepted and provisional (and disputed, withdrawn) rows; fills `positive` from templates and `negative` from the
  dictionary gate plus reviewer lines; dedupes by word key; sets `collidesWith`; builds `terms.json`, `exceptions.json`, `negative.<lang>.json`
  (capped at 2 000 lines), the manifest and hashes; runs the gate with the real `buildMatcher` over the generated pack (every `positive` line
  blocked by its own term, no `negative` line and no negative-corpus line blocked, every line in `positive.json` blocked, `loadTermPack`
  passes); refuses to build when a gate fails or when more than 200 terms were added in a month without `--allow-bulk`; prints the human
  diff (counts, ids, never words unless `--show-words`); writes the zip with ZipCrypto and the public password.
- **Tests (names):** `builds a release from a seeded D1 of invented words; the output parses with the kit's parseTermsRelease and passes loadTermPack`; `positive lines are blocked by their term, negatives never are`; `a term that fails the cross-language gate is held, not published`; `two languages sharing a folded word become one row`; `the 200-term guard`; `the diff prints ids and counts only`; `the build is deterministic: the same input twice gives byte-identical files (sorted keys, fixed timestamps from the injected clock)`; `no real word is needed: the test corpus is generated`.
- **Run:** `npx vitest run services/corpus/test/build-release.test.ts services/corpus/test/build-gates.test.ts services/corpus/test/build-diff.test.ts`

### Task S7: Keys, signing, publishing
Design 7. Needs S6 and Part A Task 2.
- **Files:** `services/corpus/tools/keygen.mjs`, `sign.mjs`, `publish.mjs`, `verify-live.mjs`, `src/tools/*.ts` (the logic, testable);
  `packages/matcher/src/corpus/keys.ts` is edited by the owner's PR in the release step, not here; tests `services/corpus/test/sign.test.ts`,
  `publish.test.ts`.
- **Behaviour:** `keygen` writes an encrypted PKCS#8 PEM (passphrase prompt, never an argument or env var by default), prints the public key
  (base64url) and its SHA-256 fingerprint, and refuses to write inside a git working tree; `sign` signs a zip or an index with the domain-separated
  message and writes the `.sig` JSON; `publish` uploads release files first and `index.json` last (R2 through `wrangler r2 object put`,
  injected for tests), increments `sequence`, sets `issuedAt`/`expiresAt` (+90 days), refuses to lower the sequence, and re-verifies
  what it uploaded with the kit's verifier; `verify-live` fetches the public URLs and verifies them end to end.
- **Tests (names):** `a signature made by sign verifies with the kit's verifySignature and fails for another kind`; `keygen refuses a path inside a git tree, writes mode 0600, and the private key never appears in stdout`; `publish uploads the index after the release files (the fake bucket records the order); a failure on the third file leaves the previous index live`; `publish refuses a lower sequence`; `the passphrase is never logged`; `verify-live passes against the fake and fails on a flipped byte`.
- **Run:** `npx vitest run services/corpus/test/sign.test.ts services/corpus/test/publish.test.ts`

### Task S8: Zenodo
Design 11. Needs S7.
- **Files:** `services/corpus/tools/zenodo.mjs`, `src/tools/zenodo.ts`; tests `services/corpus/test/zenodo.test.ts` against a fake API.
- **Behaviour:** create a new version of the concept record, upload the zip, sig and manifest, set metadata (dataset, CC-BY-4.0, the content
  warning and key fingerprints in the description), publish, return `{ doi, fileUrl }` for the index; the token comes from the environment of
  the release machine only; dry-run mode prints the metadata.
- **Tests (names):** `the call sequence and the metadata are exactly as specified`; `an API error at each step stops with a fixed message and leaves the index unchanged`; `the token never appears in a log or error`; `a re-run for the same version does not create a second version`.
- **Run:** `npx vitest run services/corpus/test/zenodo.test.ts`

### Task S9: Eval and calibration builder
Design 6.10, 12. Needs S1; independent of S3 to S8.
- **Files:** `services/corpus/src/build/eval.ts`, `src/checkCase.ts`; tests `services/corpus/test/eval-build.test.ts`, `checkcase.test.ts`.
- **Behaviour:** `checkCase(case, source?)` enforces the privacy rules of design 12 and returns closed codes (`identifier`, `contact`, `too_long`,
  `copy_of_source`, `unknown_term`); `buildEvalRelease` writes `cases.<lang>.json`, the manifest with counts per group, and reuses the zip
  writer and signer. The English set can start from the AI branch's synthetic `cases.json`.
- **Tests (names):** `checkCase refuses: a handle-shaped speaker, a URL, an email, a phone number, an invite code, 13 lines, a 201-character line, a line equal to the source line; accepts a paraphrase`; `a case whose term is not a corpus term is unknown_term`; `the built set parses with the kit's parseEvalSet`; `counts in the manifest equal the files`; `reference labels need three reviewers (meta.reviewed >= 3)`.
- **Run:** `npx vitest run services/corpus/test/eval-build.test.ts services/corpus/test/checkcase.test.ts`

### Task S10: Service docs and the owner's runbook
Design 17, 21. Last.
- **Files:** `services/corpus/README.md` (what it is, the deploy steps with exact `wrangler` commands, the tools, the first-release ceremony),
  `PRIVACY.md` (retention table, maintainers' draft, not legal advice), `SOURCES.md` (every dictionary and sentence source: name, licence,
  internal-use check, not redistributed), a contributor page `docs/community-list.md` (rules, consent, licence, removal), `docs/status.md`.
- **Tests (names):** `the README's command blocks parse (a lint over fenced blocks)`; `no document contains a term` (the allowlist scanner).
- **Run:** `npx vitest run scripts/readme.test.ts scripts/no-corpus-data.test.ts`

---

## Release

**What ships (kit):** a patch in the fixed group of ten, version assigned in merge order (the number is whatever follows the last merged
release). No new package, so the OIDC publish path is unchanged. No migration, so a database opened by this release is readable by the
one before. **The service** is not part of the tag; it is deployed by the owner.

### Before the kit tag (all in the branch)
1. `npx changeset`: patch for the group. First line: "adds an opt-in loader for the shared community term list". Then plain sentences:
   the subpaths `@chatwarden/matcher/corpus` and `@chatwarden/matcher/corpus/node`, `LiveTerms.syncPack`, the staff routes and the hub's
   Community list, the three new core names, that **no package ships any terms**, that nothing is on by default, and the `@experimental` list.
   Name the subpaths so `scripts/changelog.test.ts` passes.
2. `npm run version`.
3. **Peer floors rise by hand** (RELEASING.md "When a peer floor must rise"): `@chatwarden/http` and `@chatwarden/hub-react` on core (they
   use the new audit names), and `@chatwarden/hub-react` on `@chatwarden/http` (the community routes); `hub-element` keeps its range.
   Update `scripts/manifests.test.ts` in the same commit and name the APIs in the changeset. `matcher`, `store-*`, `profanity`, `discord`,
   `player-react` do not move.
4. `npm run check:pack` after deleting `dist`, and `node scripts/smoke.mjs`.
5. A dry run: `gh workflow run release.yml -f dry_run=true --ref k7`.
6. Merge when CI is green. **Tag and push only on the maintainer's go-ahead.**

### The first real corpus release (the owner, in this order; the maintainers' tools do the work)
1. Owner actions 1 to 4 of the design (Cloudflare R2 and login, the two subdomains, keys, reviewers and Access).
2. `wrangler d1 create`, `wrangler r2 bucket create`, apply `schema.sql`, `wrangler deploy` (all printed by the README).
3. `keygen` twice; a small PR that puts the two **public** keys in `packages/matcher/src/corpus/keys.ts` (the only edit that turns the
   loader on). Merge and release the kit patch that carries it.
4. Import the seed (owner action 5) with the service's import tool (it writes `provisional` rows with a source per term).
5. Reviewers work the queue; the owner runs `release`, reads the diff, `sign`, `publish`, `zenodo` (first record by hand, owner action 6),
   `verify-live`.
6. Point the docs at the live URLs. The site copy changes only after this has been used.

### What the adopter does (not part of the tag)
Install nothing new. Import `@chatwarden/matcher/corpus/node`, call `startCorpus({ dir, select, pin: '…' })`, pass the loader's `live` to
`adminRoutes` as `community` if they want the hub section, and add the attribution sentence to their docs. Without that, nothing changes.

---

## Spec coverage (self-review)
Design 3 (rulings) to the Global Constraints and every task; 4 to Parts A and B; 5 to S1 and S10 (and the owner actions); 6.1 to 6.3 to
Tasks 2 and S7; 6.4 to Task 3 and S6; 6.5 to 6.7 to Tasks 4 and S6; 6.8 to Tasks 8 and S3; 6.9 to S1; 6.10 to Tasks 9 and S9; 7 to Task 2, S7 and
the Release section; 8.1 to Tasks 2, 3, 4, 6; 8.2 to Task 7; 8.3 to Task 5; 8.4 to Task 8; 8.5 to Task 10; 8.6 to Tasks 1 and 14; 9 to
Tasks 4 and 6; 10 to Tasks 8, 10, 11, S3, S4, S5; 11 to S8; 12 to S9; 13 to Tasks 4 and S2; 14 to Task 11; 15 to S3, S5 and S10; 16 to Tasks 7 and
12; 17 to the Release section and S10; 18 to the per-task tests; 19 (risks) to Review Focus and Task 4's benchmark; 20 to the plan's omissions;
21 to Tasks 13 and 14. Every name used in more than one task (`CorpusError`, `signedMessage`, `verifySignature`, `parseTermsRelease`,
`releaseToPack`, `PackSelection`, `CorpusCache`, `CorpusLoader`, `SyncResult`, `ShareInput`, `wordKey`, `corpus-world`, `d1` adapter) is defined once in
its owning task and consumed under the same spelling.
