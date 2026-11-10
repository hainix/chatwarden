# Releasing Chatwarden

Seven packages are published to npm under the `@chatwarden` scope: `core`, `store-memory`, `matcher`, `store-sqlite`,
`profanity`, `http` and `discord`. They share one version number (a changesets "fixed" group), so every release bumps all seven
together.

Nothing is uploaded to npm until the owner has done the one-time steps below. Until then, the release workflow can only be
run as a dry run, and adopters can use tarballs (see "Before the first publish").

## One-time setup (the owner)

1. **Make the GitHub repository public: make hainix/chatwarden public.** It is private today, and the release cannot work
   while it is: npm provenance (the signed statement that links each package to this repository and workflow run) refuses a
   private source repository, and tag rulesets (step 5) need a public repository on the free plan. The package pages also
   link to the README, issues and source, which would 404 for everyone else. Going public is your decision, so the release
   workflow does not do it: a real publish from a private repository stops with a clear message before anything is uploaded
   (a dry run only warns). Do this before the first tag.
2. **Create the npm organisation `@chatwarden`.** Sign in at npmjs.com, choose "Add Organization", and pick the free plan.
   The scope has to exist and you have to be an owner of it before the first publish.
3. **Create a granular access token.** In your npm account, go to Access Tokens, then Generate New Token, then a granular
   access token. Make it scoped to the `@chatwarden` org, give it read and write (publish) rights for the packages in it, tick
   "Bypass 2FA" (CI cannot answer a one-time-password prompt), and set an expiry you will remember: granular tokens expire,
   so put the renewal in your calendar. The option names change from time to time, so check npm's current docs for granular
   access tokens before you create it.
4. **Add it to the repository as the secret `NPM_TOKEN`.** On GitHub: Settings, Secrets and variables, Actions, New
   repository secret. Name it exactly `NPM_TOKEN`. The first publish needs it, because npm only lets you set up trusted
   publishing (step 6) on a package that already exists. Without the secret, the workflow publishes through trusted
   publishing, and a package that has none set up fails with an auth error.
5. **Protect `v*` tags.** On GitHub: Settings, Rules, New tag ruleset, target `v*`, and restrict creation, update and
   deletion to the owner. A pushed tag publishes, so only people you trust should be able to create one.
6. **After the first publish: switch to npm trusted publishing (OIDC), and delete the token.** On npmjs.com, open each of
   the six packages, then Settings, Trusted Publisher, GitHub Actions. Enter the repository `hainix/chatwarden` and the workflow
   file `release.yml`. Then delete the `NPM_TOKEN` secret on GitHub and revoke the token on npm. The workflow needs no change:
   with no secret it publishes through trusted publishing (it upgrades npm to 11.5.1+ for this and already asks for
   `id-token: write`), and each release still carries a signed provenance statement. Check npm's current docs if the
   screens have moved.

## Each release

1. **Describe the change.** In the pull request that changes a package, run `npx changeset`. Pick the packages (the group
   moves together, so any one of them is enough), the bump (patch, minor or major) and write one plain sentence. Commit the
   file it creates under `.changeset/`.
2. **Prepare the release.** On a clean `main`, run `npm run version`. It is the one way to bump: it runs `changeset version`
   (bumps all six packages to the new version, fixes the `@chatwarden/*` ranges between them and writes each `CHANGELOG.md`),
   then `node scripts/sync-version.mjs` (rewrites the `VERSION` constant each package exports so it matches its
   `package.json`; `scripts/manifests.test.ts` fails CI if they differ), then `npm install --package-lock-only`. Then bump the
   `@chatwarden/*` versions in `examples/tiny-chat/package.json` by hand to the same version. `changesets` ignores that
   private example, and `scripts/manifests.test.ts` fails CI if it is left behind. Run `npm install` once more so
   `package-lock.json` follows.
3. **Merge.** Open a pull request with those changes and merge it once CI is green.
4. **Dry run first (recommended).** See the next section. It runs every check and `npm publish --dry-run` for all six.
5. **Tag and push.** On the merged `main`, once CI is green on it, with `X.Y.Z` the new version:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag must be exactly `v` plus the version in `packages/core/package.json`; the workflow refuses a tag that does not
   match. Pushing the tag starts the real publish. The release job runs the lint and the full test suite again before it
   uploads anything.
6. **Watch it.** Open the Actions tab and follow the "Release" run. It publishes in dependency order (`core`, `store-memory`,
   `matcher`, `store-sqlite`, `profanity`, `http`, `discord`) and skips any package whose exact version is already on npm, so a failed
   run can simply be re-run once the cause is fixed. Check each package page on npmjs.com for the provenance badge.

## Running a dry run

A dry run does everything except upload: `npm ci`, the type check, the lint, the tests, the tarball check, the consumer smoke
test (it installs the real tarballs into fresh ESM and CommonJS projects in a temporary folder outside the repository and runs
them), and `npm publish --dry-run` for each package in order. It also checks that the repository is public, and only warns
when it is not.

1. Open the repository's **Actions** tab and choose **Release** in the list on the left.
2. Choose **Run workflow**, pick the branch, leave **Dry run** ticked, and run it.

From a terminal: `gh workflow run release.yml -f dry_run=true --ref <branch>`. The dry-run box defaults to ticked. A real
publish is a tag push, and it needs `NPM_TOKEN`. A manual run with the dry-run box unticked also publishes, but only when you
pick a tag as the ref; on a branch it stops at once.

The **Provenance** box (input `provenance`, default ticked) is for the case where you deliberately want to publish without
provenance, for example from a private repository: untick it, or pass `-f provenance=false`. A tag push always uses
provenance.

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

### Docker

A Docker build needs two things the steps above do not show.

- **Copy `vendor/` before the first `npm install`** in your Dockerfile. If a `package.json` that an early `npm install`
  reads has `file:vendor/...` lines, the tarballs must already be in the image, or the install fails with ENOENT. A `file:`
  path is relative to the `package.json` that lists it.
- **With `legacy-peer-deps=true` in your `.npmrc`, peers are NOT auto-installed**, so npm will not fetch `@chatwarden/core`
  for you. List `@chatwarden/core` (and `@chatwarden/matcher` where a package needs it) as direct `file:` dependencies, as in
  the example above, and keep the `overrides` block.

A concrete example: a server in `server/` with its own `package.json`, and the tarballs in `vendor/` at the repository root.

```dockerfile
FROM node:24-slim
WORKDIR /app
# The tarballs first, so every file: dependency resolves at the first install.
COPY vendor ./vendor
COPY package.json package-lock.json .npmrc ./
RUN npm install
COPY . .
RUN cd server && npm install
```

```json
{
  "dependencies": {
    "@chatwarden/core": "file:../vendor/chatwarden-core-0.1.0.tgz",
    "@chatwarden/matcher": "file:../vendor/chatwarden-matcher-0.1.0.tgz",
    "@chatwarden/store-sqlite": "file:../vendor/chatwarden-store-sqlite-0.1.0.tgz"
  }
}
```

The second block is `server/package.json`: its paths start with `../vendor` because `server/` sits next to `vendor/`. The
root `.npmrc` may not apply inside `server/`, which is a project root of its own: if you rely on `legacy-peer-deps=true`
there, copy the `.npmrc` into `server/` too.

A worked example of an adopter doing this is in [`docs/adoption/moxgate.md`](docs/adoption/moxgate.md).
