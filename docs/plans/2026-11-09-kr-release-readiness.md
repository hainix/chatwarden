# KR: Release readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `@chatwarden/*` package publishable as-is. A tarball built from a clean checkout installs and runs
in a fresh ESM project and a fresh CommonJS project. A tag-driven workflow publishes them with provenance once the
owner adds the npm token. The same tarballs are what Moxgate vendors before the first npm publish.

**Architecture:** There are no runtime changes. This phase covers package manifests, build scripts, a pack-and-install
smoke test in CI, changesets configuration, a release workflow, and per-package READMEs.

**Tech Stack:** npm workspaces, TypeScript project references, changesets, GitHub Actions, and npm provenance.

**Spec:** docs/design/2026-11-09-chatwarden-design.md (§ distribution and "built for agents"), and
docs/design/2026-11-09-product-scope.md (§ roadmap).

## Global Constraints

- Node ≥22.13. Packages are ESM-only, with no top-level await in any published file, so that `require()` of ESM works on Node ≥22.12.
- Every package uses license Apache-2.0, with a LICENSE file in each tarball.
- `@chatwarden/core` is a **peerDependency** (`^0.1.0`) of every other package and a devDependency inside the
  monorepo. That way an adopter gets exactly one copy, and `instanceof` error mapping holds.
- All `@chatwarden/*` packages version together (changesets `fixed` group). The first version is 0.1.0.
- A tarball contains `dist/src` (js, d.ts, maps), `src` (so source maps resolve), README.md, LICENSE, and package.json.
  It never contains tests, fixtures with real slurs, or `.tsbuildinfo`.
- Subpath exports resolve under `moduleResolution: node` via `typesVersions`.
- Nothing is published from CI until the owner adds `NPM_TOKEN` and creates the `@chatwarden` npm org. The workflow
  is `workflow_dispatch` plus tag, and a dry run is the default.
- Never run the full test suite locally. CI runs it.

## Review Focus

1. A fresh CommonJS TypeScript project with `moduleResolution: node` and TS 5.7 must typecheck and run `require('@chatwarden/http/express')`.
2. `npm pack` from a clean clone must not ship stale `dist`. `prepack` builds.
3. The synthetic matcher fixtures (zorbak/vlemmo…) ship under a public `@chatwarden/matcher/fixtures` subpath, because
   adopters' tests and tiny-chat need them. Nothing else under `test/` ships.
4. Two installed copies of core must be impossible through normal installs. The peer dependency guarantees this.
5. A README test must keep each package README's snippets compiling, extending readme.test.ts to all packages.

---

### Task 1: Build and pack hygiene
- Add a root `build` script (`tsc -b`) and `clean`. Each package gets `prepack: tsc -b`. `files` is
  `["dist/src", "src", "README.md", "LICENSE"]`. Each package gets a LICENSE copy, kept in sync by a script and a test. Set `sideEffects: false`.
  Each package gets `keywords`, `homepage`, `bugs` and `repository.directory`.
- Move matcher's `test/fixtures` (synthetic pack only) to `src/fixtures`, and export it as `./fixtures` with
  typesVersions. Keep `./test-fixtures` as a deprecated alias for one release. Update tiny-chat's imports.
- Add typesVersions for every subpath.
- Test: `scripts/check-pack.mjs` runs `npm pack --dry-run --json` per package and asserts the file list against the
  rules above. Wire it into CI.

### Task 2: Dependency shape and versioning
- Make core a peerDependency (`^0.1.0`) of http, discord, store-sqlite, matcher and profanity, and a devDependency in
  the workspace. Matcher becomes a peer of profanity and of store-sqlite (already the case for store). Express ^5 and `@types/express` are optional peers of http (`peerDependenciesMeta`).
- Changesets: put all `@chatwarden/*` in one `fixed` group and ignore examples. Add an initial changeset that takes
  everything to 0.1.0, then run `changeset version` and commit the result.
- Test: a manifest test asserts the peer, dev and fixed shape for every package.

### Task 3: Consumer smoke test (CI job)
- `scripts/smoke.mjs` packs every package into `.smoke/`, then creates two temp projects:
  - ESM: `type: module`, NodeNext, TS 5.9.
  - CJS: `module: commonjs`, `moduleResolution: node`, TS 5.7.
- Each project installs the tarballs, typechecks a file that imports every entry point and subpath, and runs a
  scenario: create a chatwarden on an in-memory SqliteStore, accept a line, submit a report, decide, read the player
  notice, and mount `toExpress` on an ephemeral port to hit `/healthz`.
- Add a CI job `smoke` on Node 22.13 and 24. Upload the tarballs as a workflow artifact. Moxgate vendors those
  tarballs.

### Task 4: Release workflow
- `.github/workflows/release.yml`:
  - triggers on `workflow_dispatch` (input `dry_run`, default true) and on tags `v*`
  - steps: `npm ci`, build, check-pack, smoke, then `npm publish --provenance --access public` per package in
    dependency order, skipped when `dry_run`
  - permissions: `id-token: write`, `contents: read`
  - the token comes from `NPM_TOKEN`; the job fails with a clear message if the token is missing and `dry_run` is false
- RELEASING.md gives the owner's one-time steps (create the npm org, add the token, protect tags) and the per-release
  steps (changeset, version PR, tag).

### Task 5: Package READMEs
- Write READMEs for core, store-sqlite, matcher and profanity: install, a copy-paste quick start, options, security
  notes, and links. Use plain language.
- Extend readme.test.ts to compile every package README's ts snippets.
- Root README: install matrix, CommonJS note, Node support, link to RELEASING.md.
- The http README warns that `GET /gaps` returns moderator-written gap notes in bulk, so moderators should never paste chat into a gap note (K3b final re-review N1).
- Export `compileRoutes` (as `matchRoute`, for adapter authors) and `RETRY_AFTER_FLOOR_MS`. Document both in the http README.
