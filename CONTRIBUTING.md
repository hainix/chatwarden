# Contributing to Chatwarden

Chatwarden is pre-release and offered as-is, with no support promise. PRs are welcome.

## Before you start

- For anything big (new package, public API change, new rule), open an issue first so we can agree on the
  shape before you write code.
- Small fixes and docs can go straight to a PR.

## Rules

- **DCO sign-off is required.** Every commit must carry a `Signed-off-by` line: use `git commit -s`. A PR
  with unsigned commits will not be merged.
- **No slur data in the repo.** No real slur, hate term or profanity list, in source, tests, fixtures or
  docs. Tests use synthetic terms.
- Work test-first: add a failing test, see it fail, then make it pass. Cover variants and edge cases, not just
  the happy path.
- Licence is Apache-2.0; by contributing you agree your work is offered under it.

## Setup and checks

```sh
nvm use          # Node 22.13+
npm ci
npm run typecheck
npm run lint
npx vitest run packages/core/test/smoke.test.ts   # run only the tests you touched
```

Run tests by path while developing. CI runs the whole suite.

Some tests read the built packages: the browser bundle, pack and smoke tests. On a fresh clone, run `npm run build` once
before them.
