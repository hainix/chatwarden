# K8a: Browser-ready kit, store-memory, and Moxgate gaps (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real kit runs in a browser, which is the landing page's interactive demo (K8b). It also closes the two
gaps the Moxgate adoption found: a chat-restriction query, and a positive-corpus canary for term edits.

**Architecture:**
- core drops every static `node:` import:
  - ids come from `globalThis.crypto.getRandomValues`
  - SHA-256 and HMAC-SHA256 use Node's native crypto through `process.getBuiltinModule('node:crypto')` when it exists, and
    a small pure-JS implementation otherwise. Both are proven byte-identical.
- `MemoryStore` becomes the shipped package `@chatwarden/store-memory`.
- `cw.chat.restricted(who)` and the LiveTerms positive-corpus canary are additive APIs.

**Tech Stack:** TypeScript strict ESM, vitest, esbuild (dev only, for the browser-bundle test).

**Spec:** docs/design/2026-11-09-chatwarden-design.md (K8 "real kit in the browser"); docs/adoption/moxgate.md §7.7.

## Global Constraints

- No public API is removed or renamed. `makeHasher` and every 0.1.0 export keep their signatures, and hashes stay
  byte-identical to 0.1.0 (Moxgate depends on this).
- core `src/` has no static or dynamic `import` of a `node:` module. Node access goes through
  `process.getBuiltinModule`, guarded for absence.
- Node ≥22.13 and CI on 22.13 and 24, as before.
- Test-first, with targeted runs only. Never run the full suite locally.
- The new package follows every KR rule: peer core `^0.1.0`, the fixed group, LICENSE, README, check-pack, smoke, VERSION sync.

## Review Focus

1. Hash parity: native and pure-JS SHA-256/HMAC must agree on empty input, multi-block input (≥64 bytes and over 1 MB),
   unicode and long keys (>64 bytes), and must match NIST/RFC 4231 vectors.
2. The browser bundle of core + matcher + store-memory (esbuild, platform browser) contains no `node:` specifier and runs a
   full report → decide → notice flow in a non-Node global (happy-dom or a `vm` context without `process`).
3. `cw.chat.restricted` must never reveal a restriction to the wrong person (IP-only bystanders, the same as notices).
4. The canary runs inside the same transaction as the edit, and a refusal leaves no rows and no audit.
5. `store-memory` passes the same store contract suite as `store-sqlite`.

---

### Task 1: Isomorphic crypto in core
- **Create:** `packages/core/src/crypto.ts`, exporting:
  - `randomId(bytes = 16): string` (base64url)
  - `randomIntBelow(n)` (rejection sampling)
  - `sha256Hex(data: string): string`
  - `hmacSha256Hex(key: string, data: string): string`
  - native via `process.getBuiltinModule?.('node:crypto')`, otherwise pure JS
- **Modify:** audit, notices, reports, sanctions, strikes, subjects, decide and hasher, so they use it. Keep `makeHasher`
  output identical.
- **Lint:** an eslint `no-restricted-imports` rule bans `node:*` in `packages/core/src`.
- **Tests:**
  - RFC 4231 and NIST vectors
  - 2000 seeded random inputs comparing pure-JS against native
  - `randomId` length and alphabet
  - `randomIntBelow` uniformity (chi-square sanity)
  - `makeHasher` golden values pinned from 0.1.0
  - a test that forces the pure-JS path

### Task 2: `@chatwarden/store-memory`
- Promote `packages/core/test/memoryStore.ts` to `packages/store-memory/src`, keeping it journaled and transactional.
  core tests import it from the package as a dev dependency.
- Extract a shared Store contract suite, `packages/store-sqlite/test/contract/*`, to a place both stores run, then run it
  against both.
- Add the manifest, README, and the KR wiring (check-pack, smoke scenario on store-memory as well, manifests test, VERSION).

### Task 3: Browser bundle proof
- Add `scripts/browser-bundle.test.ts`. It esbuild-bundles core + matcher (with fixtures) + store-memory for
  `platform: 'browser'`, asserts there is no `node:` string in the output, and runs the bundle in a `vm` context with
  no `process`, `require` or `Buffer`. The run creates a chatwarden, chats, refuses `zorbak`, reports, decides a
  warning, and reads the notice.
- Wire it into CI's check job.

### Task 4: `cw.chat.restricted(who)`
- Returns `{ restricted: boolean, until: number | null, kind: 'chat' | 'ban' | null }` for the speaker's own subject.
  The answer is the same one `chat.accept` would give for a refusal.
- An IP-only match against someone else's sanction answers `restricted: true` (they can't chat) but never says whose.
  It follows the same `own` rule as notices.
- Tests mirror `chat.accept` refusal cases one to one.

### Task 5: Positive-corpus canary in LiveTerms
- `TermPack.positiveCorpus?: string[]` (optional; pack validation accepts it).
- Inside `change()`, after the edit and before commit, rebuild the candidate matcher. If any positive line is no longer
  matched, roll back and return `{ ok: false, reason: 'unblocks_known', count }`, with a count and no text.
- Tests: exception add, update and toggle, term disable and update, and a no-op edit. The refusal writes no rows and no audit.
- The synthetic fixtures pack gains a positive corpus.

### Task 6: Release 0.1.1 notes
- Add changesets (patch for the existing packages, minor for the new store-memory, which is held at the fixed-group
  version). Run `npm run version`, and update the READMEs (core: browser support; matcher: positiveCorpus; store-memory).
- Do NOT tag. The owner or controller tags after review, and the publish also exercises trusted publishing.
