# Releasing Chatwarden

Six packages are published to npm under the `@chatwarden` scope: `core`, `matcher`, `store-sqlite`, `profanity`, `http` and
`discord`. They share one version number (a changesets "fixed" group), so every release bumps all six together.

Nothing is uploaded to npm until the owner has done the one-time steps below. Until then, the release workflow can only be
run as a dry run, and adopters can use tarballs (see "Before the first publish").

## One-time setup (the owner)

1. **Create the npm organisation `@chatwarden`.** Sign in at npmjs.com, choose "Add Organization", and pick the free plan.
   The scope has to exist and you have to be an owner of it before the first publish.
2. **Create an automation token.** In your npm account, go to Access Tokens, then Generate New Token, then a granular token
   (or a classic "Automation" token). Give it read and write access to the `@chatwarden` packages, and set an expiry you
   will remember. An automation token skips the one-time-password prompt, which CI cannot answer.
3. **Add it to the repository as the secret `NPM_TOKEN`.** On GitHub: Settings, Secrets and variables, Actions, New
   repository secret. Name it exactly `NPM_TOKEN`. If it is missing or empty, the release workflow stops with a clear
   message before it publishes anything.
4. **Protect `v*` tags.** On GitHub: Settings, Rules, New tag ruleset, target `v*`, and restrict creation, update and
   deletion to the owner. A pushed tag publishes, so only people you trust should be able to create one.
5. **Optional: switch to npm trusted publishing.** Once the packages exist on npm, each package's Settings page lets you add
   this repository and the workflow file `release.yml` as a trusted publisher. With that in place you can delete the
   `NPM_TOKEN` secret: npm then accepts the workflow's own short-lived identity. The workflow already asks for
   `id-token: write` and publishes with `--provenance`, so each release carries a signed provenance statement either way.

## Each release

1. **Describe the change.** In the pull request that changes a package, run `npx changeset`. Pick the packages (the group
   moves together, so any one of them is enough), the bump (patch, minor or major) and write one plain sentence. Commit the
   file it creates under `.changeset/`.
2. **Prepare the release.** On a clean `main`, run `npx changeset version`. It bumps all six packages to the new version,
   fixes the `@chatwarden/*` ranges between them, and writes each `CHANGELOG.md`. Then bump the `@chatwarden/*` versions in
   `examples/tiny-chat/package.json` by hand to the same version. `changesets` ignores that private example, and
   `scripts/manifests.test.ts` fails CI if it is left behind. Run `npm install` so `package-lock.json` follows.
3. **Merge.** Open a pull request with those changes and merge it once CI is green.
4. **Dry run first (recommended).** See the next section. It runs every check and `npm publish --dry-run` for all six.
5. **Tag and push.** On the merged `main`, with `X.Y.Z` the new version:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag must be exactly `v` plus the version in `packages/core/package.json`; the workflow refuses a tag that does not
   match. Pushing the tag starts the real publish.
6. **Watch it.** Open the Actions tab and follow the "Release" run. It publishes in dependency order (`core`, `matcher`,
   `store-sqlite`, `profanity`, `http`, `discord`) and skips any package whose exact version is already on npm, so a failed
   run can simply be re-run once the cause is fixed. Check each package page on npmjs.com for the provenance badge.

## Running a dry run

A dry run does everything except upload: `npm ci`, the type check, the tarball check, the consumer smoke test (it installs
the real tarballs into fresh ESM and CommonJS projects and runs them), and `npm publish --dry-run --provenance` for each
package in order.

1. Open the repository's **Actions** tab and choose **Release** in the list on the left.
2. Choose **Run workflow**, pick the branch, leave **Dry run** ticked, and run it.

From a terminal: `gh workflow run release.yml -f dry_run=true --ref <branch>`. The dry-run box defaults to ticked. Untick it
to publish from a manual run; that needs `NPM_TOKEN`. A tag push is always a real publish.

## Before the first publish: vendoring tarballs

Until the packages are on npm, an adopter can build the exact tarballs from a checkout and install those.

1. In a checkout of this repository: `npm ci`, then `node scripts/smoke.mjs`. It builds and packs every package and checks
   them in a fresh ESM and CommonJS project. The tarballs are left in `.smoke/tarballs/*.tgz`. (The CI "Smoke" job uploads
   the same files as the `chatwarden-tarballs` artifact.)
2. Copy the `.tgz` files into your project, for example into `vendor/`, and commit them.
3. Reference them with `file:`, and add `overrides` so every package that has `@chatwarden/core` (or `matcher`) as a peer
   gets your copy, which keeps a single copy of core in the install:

   ```json
   {
     "dependencies": {
       "@chatwarden/core": "file:vendor/chatwarden-core-0.1.0.tgz",
       "@chatwarden/matcher": "file:vendor/chatwarden-matcher-0.1.0.tgz",
       "@chatwarden/store-sqlite": "file:vendor/chatwarden-store-sqlite-0.1.0.tgz",
       "@chatwarden/http": "file:vendor/chatwarden-http-0.1.0.tgz"
     },
     "overrides": {
       "@chatwarden/core": "$@chatwarden/core",
       "@chatwarden/matcher": "$@chatwarden/matcher"
     }
   }
   ```

   Add `profanity` and `discord` the same way if you use them. `$@chatwarden/core` means "the version named in my own
   `dependencies`". Run `npm install`; `npm ls @chatwarden/core` should show exactly one copy.
4. When the packages reach npm, replace each `file:` line with `^0.1.0` and delete the `overrides` block.

A worked example of an adopter doing this is in [`docs/adoption/moxgate.md`](docs/adoption/moxgate.md).
