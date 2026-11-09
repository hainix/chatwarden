# AGENTS.md

Rules for any agent or contributor working in this repo.

## Rules

- Licence is Apache-2.0. Every commit is DCO signed off (`git commit -s`).
- Node `>=22.13`, set in every `package.json` `engines` and in `.nvmrc` (`22.13`).
- ESM only (`"type": "module"`). TypeScript `strict` with `erasableSyntaxOnly: true`: no parameter
  properties, no enums.
- `@chatwarden/core` imports nothing from `node:` except `node:crypto`, and has no runtime dependencies. An
  eslint `no-restricted-imports` rule enforces this.
- No real slur, hate term or profanity list in the repo. Tests use synthetic terms.
- No identifier (client key, account id, IP, any hash, subject id) appears in a value the API returns for a
  player: refusals and deliveries carry reasons, rule numbers, times and line ids only.
- IP never links two subjects and never delivers a notice. An IP sanction row lasts at most 24 h.
- Every time comes from the injected `Clock` (`now(): number`, epoch ms). No `Date.now()` in package code.
- Exact values:
  - chat length 200
  - rate limit 3 per 5 000 ms per room:seat
  - evidence buffer 100 lines / 900 000 ms per room
  - slur strikes: 3 in 3 600 000 ms, then a 30 min chat restriction; a repeat within 7 days, then 24 h
  - reports: 10 per reporter per 24 h; suspension after 3 bad-faith dismissals within 30 days
  - mutes: 180-day TTL, 500 per viewer
  - matcher: minimum collapsed term length 3
  - hasher: HMAC-SHA256 over `${kind}:${input}`, first 32 hex characters
- Work test-first: failing test, seen red, then green. Cover variants and edge cases.

## Running tests

Run targeted tests only; never an unfiltered `vitest run` locally. CI runs the whole suite.

```sh
npx vitest run packages/core/test/smoke.test.ts
```

Quality gates: `npm run typecheck` and `npm run lint`.
